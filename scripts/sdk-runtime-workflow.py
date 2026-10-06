"""Runs against the local API/runtime harness, including clean installed SDKs."""
import json
import sys
from mainbrella import Mainbrella, MainbrellaError

url, key, directory = sys.argv[1:]
client = Mainbrella(key, base_url=url)
assert client.capabilities()["files"]["list"]
sandbox = client.create(idempotency_key="python-runtime-create", internet=False, poll_interval=0.001)
assert sandbox.internet is False
try:
    history = sandbox.events()
    assert [event["type"] for event in history["events"]] == ["starting", "started"]
    configured = sandbox.webhook.configure("https://relay.example.com/callback", replay_from_cursor=0)
    assert configured["signingSecret"].startswith("mbwh_")
    assert len(sandbox.webhook.deliveries()["deliveries"]) == 2
    assert "signingSecret" not in sandbox.webhook.get()
    sandbox.webhook.remove()
    result = sandbox.commands.run("printf python; printf err >&2")
    assert result["stdout"] == "python" and result["stderr"] == "err"
    path = directory + "/python 界 &?.bin"
    sandbox.files.write(path, bytes([0, 128, 255]))
    assert sandbox.files.read(path) == bytes([0, 128, 255])
    sandbox.files.mkdir(directory + "/python-dir")
    sandbox.files.move(path, directory + "/python-dir/moved")
    sandbox.files.chmod(directory + "/python-dir/moved", "0640")
    assert sandbox.files.stat(directory + "/python-dir/moved")["mode"] == "0640"
    assert sandbox.files.list(directory + "/python-dir")["entries"][0]["name"] == "moved"
    job = sandbox.commands.start(["cat"], stdin=True, idempotency_key="python-input")
    for _ in range(100):
        if job.get()["status"] == "running":
            break
        import time
        time.sleep(0.001)
    job.stdin.write("héllo 界\n".encode())
    job.stdin.close()
    assert job.wait(poll_interval=0.001)["stdout"] == "héllo 界\n"
    attached = sandbox.commands.attach(job.id)
    assert any(event.get("data") == "héllo 界\n" for event in attached.events())
    assert any(record["id"] == job.id for record in sandbox.commands.list()["executions"])
    long = sandbox.commands.start("exec sleep 10", idempotency_key="python-cancel")
    long.cancel()
    assert long.wait(poll_interval=0.001)["status"] == "canceled"
    sandbox.files.remove(directory + "/python-dir", recursive=True)
finally:
    sandbox.kill()
print(json.dumps({"language": "python", "cleanedUp": True}))
