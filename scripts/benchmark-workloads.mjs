// Pinned inputs; fresh directories and package caches for each generation.
export const workloadDefinitions = {
  node: [
    { name: 'npm-install', command: `mkdir -p /workspace/bench/src; cd /workspace/bench; npm init -y >/dev/null; npm install --save-exact --cache /tmp/bench-npm --fetch-retries=0 --fetch-timeout=30000 typescript@5.9.3 esbuild@0.25.11` },
    { name: 'typescript-build-test', command: `cd /workspace/bench; node -e 'const fs=require("fs"); for(let i=0;i<200;i++)fs.writeFileSync("src/m"+i+".ts","export const v"+i+": number = "+i+";\\n"); fs.writeFileSync("src/index.ts",Array.from({length:200},(_,i)=>"export * from "+JSON.stringify("./m"+i)+";").join("\\n"))'; ./node_modules/.bin/tsc --outDir dist --module commonjs src/*.ts; ./node_modules/.bin/esbuild src/index.ts --bundle --platform=node --outfile=bundle.cjs; node -e 'const assert=require("assert"),v=require("./bundle.cjs"); assert.equal(Object.keys(v).length,200); assert.equal(v.v199,199); console.log("200 modules verified")'` },
    { name: 'browser-install', command: `cd /workspace/bench; trap 'code=$?; tail -c 16384 browser-install.log; exit "$code"' EXIT; { npm install --save-exact --cache /tmp/bench-npm --fetch-retries=0 --fetch-timeout=30000 playwright@1.56.0; DEBIAN_FRONTEND=noninteractive PLAYWRIGHT_BROWSERS_PATH=/tmp/bench-browsers ./node_modules/.bin/playwright install --with-deps --only-shell chromium; } > browser-install.log 2>&1` },
    { name: 'browser-test', command: `cd /workspace/bench; PLAYWRIGHT_BROWSERS_PATH=/tmp/bench-browsers node -e 'const assert=require("assert"); (async()=>{const b=await require("playwright").chromium.launch({headless:true,args:["--no-sandbox"]}); try {const p=await b.newPage(); await p.setContent("<button onclick=\\"this.textContent=123\\">Run</button>"); await p.getByRole("button").click(); assert.equal(await p.getByRole("button").textContent(),"123"); const image=await p.screenshot(); assert(image.length>100); console.log("DOM interaction and screenshot verified",image.length)} finally {await b.close()}})().catch(e=>{console.error(e);process.exitCode=1})'` },
  ],
  python: [
    { name: 'pip-install', command: `cd /workspace; python -m venv bench-venv; bench-venv/bin/python -m pip install --no-cache-dir --retries 0 --timeout 30 requests==2.32.5 numpy==2.3.4` },
    { name: 'python-build-test', command: String.raw`cd /workspace; bench-venv/bin/python - <<'PY'
import compileall, pathlib, unittest, numpy as np, requests
p=pathlib.Path('bench-python'); p.mkdir(exist_ok=True)
for i in range(200): (p/f'm{i}.py').write_text(f'value = {i}\n')
assert compileall.compile_dir(str(p), quiet=1)
class TestWorkload(unittest.TestCase):
    def test_matrix(self):
        x=np.arange(40000,dtype=np.float64).reshape(200,200)
        self.assertEqual((x @ x.T).shape,(200,200))
        self.assertEqual(requests.__version__,'2.32.5')
unittest.main()
PY` },
  ],
  rust: [
    { name: 'cargo-fetch', command: `export PATH=/usr/local/cargo/bin:$PATH RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/tmp/bench-cargo; cd /workspace; cargo new --lib bench-rust; cd bench-rust; printf '\nserde = { version = "=1.0.228", features = ["derive"] }\nserde_json = "=1.0.145"\n' >> Cargo.toml; cargo fetch` },
    { name: 'rust-build-test', command: `export PATH=/usr/local/cargo/bin:$PATH RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/tmp/bench-cargo; cd /workspace/bench-rust; cat > src/lib.rs <<'RS'
use serde::{Serialize, Deserialize};
#[derive(Serialize, Deserialize, PartialEq, Debug)]
pub struct Row { pub value: u64 }
#[cfg(test)] mod tests { use super::*; #[test] fn roundtrip() { let rows: Vec<Row> = (0..10000).map(|value| Row {value}).collect(); let json = serde_json::to_string(&rows).unwrap(); let decoded: Vec<Row> = serde_json::from_str(&json).unwrap(); assert_eq!(rows, decoded); } }
RS
CARGO_HOME=/tmp/bench-cargo cargo test --locked --offline; CARGO_HOME=/tmp/bench-cargo cargo build --release --locked --offline` },
  ],
};

export const diagnosticCommand = `export PATH=/usr/local/cargo/bin:$PATH RUSTUP_HOME=/usr/local/rustup; uname -m; for p in /sys/fs/cgroup/cpu.max /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory.peak /sys/fs/cgroup/cpu.stat; do if [ -f "$p" ]; then printf '%s\\n' "$p"; cat "$p"; fi; done; df -B1 /workspace; cat /proc/meminfo | head -3; for tool in node npm python rustc cargo; do if command -v "$tool" >/dev/null; then "$tool" --version; fi; done`;
