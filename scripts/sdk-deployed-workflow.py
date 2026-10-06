"""Qualification through a clean installed Python SDK; credentials stay in env."""
import json
import os
import re
import uuid
import platform
from pathlib import Path
from datetime import datetime


def verify_deployed_sdk(client, catalog_id="node", checkpoint=lambda report: None):
    report = {"ok": False, "language": "python", "runtime": platform.python_version(), "cleanup": "not_needed", "checks": {}, "stage": "preflight"}
    sandbox = None

    def save():
        checkpoint(json.loads(json.dumps(report)))

    def identity(candidate):
        return {"id": candidate.id, "createdAt": candidate.created_at}

    try:
        capabilities = client.capabilities()
        required = {"containers": ("idempotentCreate", "generationRequired"),
                    "execution": ("foreground", "background", "streaming", "reconnect", "cancellation"),
                    "files": ("read", "write", "binary")}
        if (not re.fullmatch(r"[\w.-]{1,80}", capabilities.get("apiVersion", ""))
                or not all(capabilities.get(group, {}).get(name) is True for group, names in required.items() for name in names)):
            raise ValueError()
        account = client.list()
        limits, usage = account["limits"], account["usage"]
        if (account.get("active") is not True or not isinstance(account.get("containers"), list)
                or not any(image["id"] == catalog_id for image in account["imageCatalog"])
                or not all(type(value) is int and value >= 0 for value in (limits["maxStartsPerMonth"], limits["maxContainers"], usage["starts"]))
                or limits["maxStartsPerMonth"] - usage["starts"] < 1 or limits["maxContainers"] <= len(account["containers"])
                or not 0 < usage["availableComputeUnitHours"] < float("inf")
                or not 0 <= usage["concurrentComputeUnits"] < float("inf")
                or not usage["concurrentComputeUnits"] + 1 <= limits["maxConcurrentComputeUnits"] < float("inf")):
            raise ValueError()
        report["apiVersion"] = capabilities["apiVersion"]
        report["preexisting"] = [{"id": c["id"], "createdAt": c["createdAt"]} for c in account["containers"]]
        for previous in report["preexisting"]:
            if (not re.fullmatch(r"small|c[1-9]\d{0,2}", previous["id"])
                    or datetime.fromisoformat(previous["createdAt"].replace("Z", "+00:00")).isoformat(timespec="milliseconds").replace("+00:00", "Z") != previous["createdAt"]):
                raise ValueError()
        report["creationKey"] = str(uuid.uuid4())
        report["stage"], report["cleanup"] = "create", "reconcile_manually"
        save()
        candidate = client.create(catalog_id=catalog_id, size="lite", idempotency_key=report["creationKey"])
        report["container"] = identity(candidate)
        if report["container"] in report["preexisting"]:
            raise ValueError()
        sandbox = candidate
        if candidate.instance != "lite":
            raise ValueError()
        report["stage"], report["cleanup"] = "idempotency", "pending"
        save()
        replay = client.create(catalog_id=catalog_id, size="lite", idempotency_key=report["creationKey"])
        if identity(replay) != identity(sandbox):
            report["unexpectedGeneration"] = identity(replay)
            raise ValueError()
        report["checks"]["idempotentAdmission"] = True
        report["stage"] = "foreground"
        save()
        result = sandbox.commands.run("printf mainbrella-probe; printf mainbrella-stderr >&2", timeout_ms=30000)
        if (result.get("stdout") != "mainbrella-probe" or result.get("stderr") != "mainbrella-stderr"
                or result.get("exitCode") != 0 or result.get("timedOut") is not False or result.get("outputTruncated") is not False):
            raise ValueError()
        report["checks"]["stdoutStderr"] = True
        report["stage"] = "files"
        save()
        data = bytes([0, 1, 127, 128, 255, 10])
        path = f'/tmp/mainbrella-sdk-{report["creationKey"]}.bin'
        sandbox.files.write(path, data)
        if sandbox.files.read(path) != data:
            raise ValueError()
        report["checks"]["binaryFiles"] = True
        report["stage"], report["executionKey"] = "managed", str(uuid.uuid4())
        save()
        job = sandbox.commands.start("printf mainbrella-managed; printf mainbrella-managed-err >&2",
                                     timeout_ms=30000, idempotency_key=report["executionKey"])
        report["executionId"] = job.id
        save()
        stdout, stderr, terminal, cursor = "", "", None, 0
        events = job.events()
        try:
            for event in events:
                if event["type"] == "status":
                    terminal = event["execution"]
                    continue
                if event["type"] == "stdout":
                    stdout += event["data"]
                elif event["type"] == "stderr":
                    stderr += event["data"]
                else:
                    raise ValueError()
                cursor = job.cursor
                if len(stdout) + len(stderr) > 1024:
                    raise ValueError()
                break
        finally:
            events.close()
        if type(cursor) is not int or cursor < 1:
            raise ValueError()
        report["reconnectCursor"] = cursor
        save()
        attached = sandbox.commands.attach(job.id)
        events = attached.events(cursor=cursor)
        try:
            for event in events:
                if event["type"] == "status":
                    terminal = event["execution"]
                elif event["type"] == "stdout":
                    stdout += event["data"]
                elif event["type"] == "stderr":
                    stderr += event["data"]
                else:
                    raise ValueError()
                if len(stdout) + len(stderr) > 1024:
                    raise ValueError()
        finally:
            events.close()
        complete = attached.get()
        if (stdout != "mainbrella-managed" or stderr != "mainbrella-managed-err" or terminal.get("status") != "succeeded"
                or complete.get("status") != "succeeded" or complete.get("stdout") != stdout or complete.get("stderr") != stderr
                or complete.get("exitCode") != 0 or complete.get("timedOut") is not False or complete.get("outputTruncated") is not False):
            raise ValueError()
        report["checks"]["managedReconnect"] = True
        report["stage"], report["cancellationKey"] = "cancellation", str(uuid.uuid4())
        save()
        job = sandbox.commands.start("exec sleep 30", timeout_ms=30000, idempotency_key=report["cancellationKey"])
        report["cancellationId"] = job.id
        save()
        job.cancel()
        if job.wait(timeout=45)["status"] != "canceled":
            raise ValueError()
        report["checks"]["cancellation"] = True
    except Exception:
        report["error"] = report["stage"] + "_failed"
    finally:
        if sandbox is not None:
            try:
                report["stage"] = "cleanup"
                save()
            finally:
                try:
                    sandbox.kill()
                    after = client.list()
                    if (not isinstance(after.get("containers"), list)
                            or any({"id": c["id"], "createdAt": c["createdAt"]} == identity(sandbox) for c in after["containers"])):
                        raise ValueError()
                    report["cleanup"] = "completed"
                except Exception:
                    report["cleanup"] = "failed"
    report["stage"] = "finished"
    report["ok"] = "error" not in report and report["cleanup"] == "completed"
    save()
    return report


if __name__ == "__main__":
    try:
        from mainbrella import Mainbrella

        output = Path(os.environ["MAINBRELLA_SDK_REPORT"])

        def checkpoint(report):
            temporary = output.with_suffix(".tmp")
            descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(descriptor, "w") as handle:
                json.dump(report, handle, indent=2)
                handle.write("\n")
            os.replace(temporary, output)

        client = Mainbrella(os.environ["MAINBRELLA_API_KEY"], base_url=os.environ["MAINBRELLA_API_URL"])
        result = verify_deployed_sdk(client, os.environ.get("MAINBRELLA_CATALOG_ID", "node"), checkpoint)
        raise SystemExit(0 if result["ok"] else 1)
    except Exception:
        raise SystemExit(1) from None
