import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import uuid
from mainbrella import Mainbrella, MainbrellaError

AUTHOR = {'name': 'SDK Test', 'email': 'sdk-test@example.invalid'}


class GitTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='mainbrella-git-')
        self.addCleanup(self.temporary.cleanup)
        self.cwd = self.temporary.name
        self.raw('init', '-b', 'main')
        self.sandbox = Mainbrella('mb_' + 'a' * 64).connect('small', '2026-10-12T14:00:00.000Z')
        self.calls = []
        def start(argv, **options):
            self.calls.append((argv, options))
            result = subprocess.run(argv, cwd=options['cwd'], env=dict(os.environ, **options['env']),
                                    capture_output=True, text=True, timeout=options['timeout_ms'] / 1000)
            class Execution:
                id = str(uuid.uuid4())
                def wait(inner, **kwargs):
                    return {'stdout': result.stdout, 'stderr': result.stderr, 'exitCode': result.returncode,
                            'status': 'succeeded' if result.returncode == 0 else 'failed', 'outputTruncated': False, 'timedOut': False}
            return Execution()
        self.sandbox.commands.start = start

    def raw(self, *args):
        result = subprocess.run(['git', *args], cwd=self.cwd, capture_output=True, text=True,
                                env=dict(os.environ, GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null'))
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def test_real_git_status_diff_commit_branch_and_non_destructive_checkout(self):
        git = self.sandbox.git
        original, renamed = 'space and\nnewline', '-$(touch injected)'
        Path(self.cwd, original).write_text('before\n')
        self.raw('add', '--', original)
        self.assertIn('+before', git.diff(cwd=self.cwd, staged=True, paths=[original])['patch'])
        self.assertTrue(git.commit(cwd=self.cwd, message='Initial', author=AUTHOR, idempotency_key='first')['committed'])
        self.assertEqual(git.status(cwd=self.cwd)['entries'], [])
        git.checkout(cwd=self.cwd, branch='work/topic', create=True, idempotency_key='branch')
        self.raw('tag', 'work/topic')
        Path(self.cwd, original).rename(Path(self.cwd, renamed))
        self.raw('add', '-A')
        self.assertEqual(git.status(cwd=self.cwd)['entries'], [{'indexStatus': 'R', 'worktreeStatus': ' ', 'path': renamed, 'originalPath': original}])
        self.assertEqual([(b['name'], b['current']) for b in git.branches(cwd=self.cwd)['branches']], [('main', False), ('work/topic', True)])
        git.commit(cwd=self.cwd, message='Rename', author=AUTHOR, idempotency_key='rename')
        Path(self.cwd, renamed).write_text('unsaved\n')
        with self.assertRaises(MainbrellaError) as raised:
            git.checkout(cwd=self.cwd, branch='main', idempotency_key='unsafe')
        self.assertEqual(raised.exception.code, 'git_command_failed')
        self.assertTrue(raised.exception.execution_id)
        self.assertEqual(Path(self.cwd, renamed).read_text(), 'unsaved\n')
        self.assertFalse(Path(self.cwd, 'injected').exists())

    def test_filters_hooks_and_signing_do_not_execute(self):
        git = self.sandbox.git
        Path(self.cwd, 'tracked').write_text('before\n')
        self.raw('add', 'tracked')
        git.commit(cwd=self.cwd, message='Base', author=AUTHOR, idempotency_key='base')
        marker = Path(self.cwd, 'executed')
        command = "touch '" + str(marker) + "'; cat"
        for setting in ('filter.trap.clean', 'filter.trap.smudge', 'diff.trap.command', 'diff.trap.textconv'):
            self.raw('config', setting, command)
        self.raw('config', 'filter.trap.required', 'true')
        self.raw('config', 'commit.gpgsign', 'true')
        Path(self.cwd, '.gitattributes').write_text('* filter=trap diff=trap\n')
        hook = Path(self.cwd, '.git/hooks/pre-commit')
        hook.write_text("#!/bin/sh\ntouch '" + str(marker) + "'\nexit 1\n")
        hook.chmod(0o700)
        Path(self.cwd, 'tracked').write_text('after\n')
        self.assertTrue(git.status(cwd=self.cwd)['entries'])
        self.assertIn('+after', git.diff(cwd=self.cwd)['patch'])
        git.checkout(cwd=self.cwd, branch='other', create=True, idempotency_key='other')
        self.raw('-c', 'filter.trap.clean=', '-c', 'filter.trap.required=false', 'add', 'tracked')
        git.commit(cwd=self.cwd, message='Safe commit', author=AUTHOR, idempotency_key='safe')
        git.checkout(cwd=self.cwd, branch='main', idempotency_key='restore')
        self.assertEqual(Path(self.cwd, 'tracked').read_text(), 'before\n')
        self.assertFalse(marker.exists())

    def test_option_injection_truncation_and_failed_start_keep_recovery_identity(self):
        git = self.sandbox.git
        for branch in ('-C', '@{-1}', 'a..b', 'name.lock', 'x\ncommand'):
            with self.assertRaisesRegex(MainbrellaError, 'invalid_git_options'):
                git.checkout(cwd=self.cwd, branch=branch, idempotency_key='bad')
        self.assertEqual(len(self.calls), 0)
        class Execution:
            id = 'retained'
            def wait(inner, **kwargs):
                return {'stdout': '?? partial', 'stderr': '', 'exitCode': 0, 'status': 'succeeded', 'outputTruncated': True}
        self.sandbox.commands.start = lambda *args, **kwargs: Execution()
        with self.assertRaises(MainbrellaError) as raised:
            git.status(cwd=self.cwd, idempotency_key='read-key')
        self.assertEqual(raised.exception.code, 'git_output_limit')
        self.assertEqual(raised.exception.execution_id, 'retained')
        self.assertEqual(raised.exception.idempotency_key, 'read-key')

    def test_ambiguous_mutation_does_not_claim_the_configuration_execution(self):
        starts = []
        class Execution:
            id = 'configuration-only'
            def wait(inner, **kwargs):
                return {'status': 'failed', 'exitCode': 1, 'stdout': '', 'stderr': '', 'timedOut': False, 'outputTruncated': False}
        def start(*args, **kwargs):
            starts.append(True)
            if len(starts) == 2:
                raise MainbrellaError('transport_unavailable')
            return Execution()
        self.sandbox.commands.start = start
        with self.assertRaises(MainbrellaError) as raised:
            self.sandbox.git.commit(cwd=self.cwd, author=AUTHOR, message='One mutation', idempotency_key='mutation-key')
        self.assertEqual(raised.exception.idempotency_key, 'mutation-key')
        self.assertEqual(raised.exception.git_phase, 'operation')
        self.assertEqual(raised.exception.configuration_execution_id, 'configuration-only')
        self.assertFalse(hasattr(raised.exception, 'execution_id'))
        self.assertEqual(len(starts), 2)


if __name__ == '__main__':
    unittest.main()
