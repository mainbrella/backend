"""Check built Python archives without importing the working tree."""
import email
import pathlib
import sys
import tarfile
import zipfile

output, license_path, version = sys.argv[1:]
license_bytes = pathlib.Path(license_path).read_bytes()
for artifact in pathlib.Path(output).iterdir():
    if artifact.suffix == ".whl":
        with zipfile.ZipFile(artifact) as archive:
            files = {name: archive.read(name) for name in archive.namelist()}
        metadata_name = next(name for name in files if name.endswith(".dist-info/METADATA"))
        assert "mainbrella/__init__.py" in files
        assert not any("test_" in name or "__pycache__" in name for name in files)
    elif artifact.name.endswith(".tar.gz"):
        with tarfile.open(artifact) as archive:
            files = {member.name: archive.extractfile(member).read() for member in archive if member.isfile()}
        metadata_name = next(name for name in files if name.count("/") == 1 and name.endswith("/PKG-INFO"))
        assert any(name.endswith("/mainbrella/__init__.py") for name in files)
        assert any(name.endswith("/pyproject.toml") for name in files)
    else:
        continue
    metadata = email.message_from_bytes(files[metadata_name])
    assert metadata["Name"] == "mainbrella"
    assert metadata["Version"] == version
    assert metadata["License-Expression"] == "GPL-3.0-only"
    assert not metadata.get_all("Requires-Dist")
    assert any(name.endswith("/LICENSE") and data == license_bytes for name, data in files.items())
print("Python wheel/sdist metadata, source, dependency and license checks passed.")
