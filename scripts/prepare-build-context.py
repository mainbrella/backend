"""Materialize a bounded build context on the disposable, credential-free runner."""
import base64
import io
import json
import pathlib
import re
import sys
import tarfile


def prepare(source, destination):
    dockerfile = source.get('dockerfile')
    if not isinstance(dockerfile, str) or len(dockerfile.encode()) > 16384 or '\0' in dockerfile:
        raise ValueError('Invalid Dockerfile')
    lines = dockerfile.replace('\r\n', '\n').splitlines()
    first = next((line.strip() for line in lines if line.strip() and not line.lstrip().startswith('#')), '')
    if not re.fullmatch(r'FROM mainbrella:base', first, re.I) or sum(bool(re.match(r'\s*FROM\b', line, re.I)) for line in lines) != 1:
        raise ValueError('Use one FROM mainbrella:base stage')
    if any(re.match(r'\s*#\s*(syntax|escape)\s*=', line, re.I) for line in lines):
        raise ValueError('Custom Dockerfile parser directives are unsupported')
    destination = pathlib.Path(destination)
    destination.mkdir(parents=True, exist_ok=False)
    encoded = source.get('contextBase64')
    if encoded:
        compressed = base64.b64decode(encoded, validate=True)
        if len(compressed) > 512 * 1024:
            raise ValueError('Context exceeds 512 KiB')
        seen = set()
        total = 0
        with tarfile.open(fileobj=io.BytesIO(compressed), mode='r|gz') as archive:
            for member in archive:
                path = pathlib.PurePosixPath(member.name)
                if member.name in ('.', './') and member.isdir():
                    continue
                if path.is_absolute() or '..' in path.parts or '\\' in member.name or not path.parts:
                    raise ValueError('Unsafe archive path')
                if not member.isfile() and not member.isdir():
                    raise ValueError('Links and special files are unsupported')
                normalized = str(path)
                if normalized in seen or len(seen) >= 2000:
                    raise ValueError('Duplicate or too many archive entries')
                seen.add(normalized)
                total += member.size
                if member.size < 0 or total > 20 * 1024 * 1024:
                    raise ValueError('Expanded context exceeds 20 MiB')
                target = destination.joinpath(*path.parts)
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with archive.extractfile(member) as content:
                        target.write_bytes(content.read())
                    target.chmod(0o755 if member.mode & 0o111 else 0o644)
    # An archive cannot replace the submitted recipe.
    (destination / 'Dockerfile').write_text(dockerfile)


if __name__ == '__main__':
    prepare(json.loads(pathlib.Path(sys.argv[1]).read_text()), sys.argv[2])
