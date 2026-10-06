import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { workloadDefinitions } from './benchmark-workloads.mjs';

test('every benchmark fixture is valid shell and Python fixture parses before paid starts',()=>{
  for(const phases of Object.values(workloadDefinitions))for(const phase of phases){
    const shell=spawnSync('bash',['-n'],{input:phase.command,encoding:'utf8'});assert.equal(shell.status,0,phase.name+': '+shell.stderr);
  }
  const source=workloadDefinitions.python[1].command.split("<<'PY'\n")[1].replace(/\nPY$/,'');
  const python=spawnSync('python3',['-c','import ast,sys; ast.parse(sys.stdin.read())'],{input:source,encoding:'utf8'});
  assert.equal(python.status,0,python.stderr);
});
