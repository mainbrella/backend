"""Convert a Docker-save image into a bounded OCI layout for offline inline-cache import.

Never extract archive paths: content is copied to locally computed digest names.
The original image config retains BuildKit's inline cache records.
"""
import hashlib
import json
from pathlib import Path
import sys
import tarfile

MAX_BYTES = 512 * 1024 * 1024
MAX_METADATA = 1024 * 1024


def prepare_cache(archive_path, destination):
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=False)
    blobs = destination / 'blobs' / 'sha256'
    blobs.mkdir(parents=True)
    total = 0
    with tarfile.open(archive_path, 'r:') as archive:
        names = set()
        for member in archive:
            if member.name in names or len(names) >= 4096:
                raise ValueError('Invalid image archive entries')
            names.add(member.name)

        def member_file(name, limit):
            if not isinstance(name, str):
                raise ValueError('Invalid image member')
            member = archive.getmember(name)
            if not member.isfile() or member.size < 0 or member.size > limit:
                raise ValueError('Invalid image member')
            return archive.extractfile(member)

        def store_bytes(data, media_type):
            digest = hashlib.sha256(data).hexdigest()
            (blobs / digest).write_bytes(data)
            return {'mediaType': media_type, 'digest': 'sha256:' + digest, 'size': len(data)}

        with member_file('manifest.json', MAX_METADATA) as stream:
            manifest = json.load(stream)
        if not isinstance(manifest, list) or len(manifest) != 1:
            raise ValueError('Expected one saved cache image')
        saved = manifest[0]
        if not isinstance(saved.get('Layers'), list) or len(saved['Layers']) > 512:
            raise ValueError('Invalid image layer count')
        with member_file(saved.get('Config'), MAX_METADATA) as stream:
            config_bytes = stream.read()
        config = json.loads(config_bytes)
        if config.get('os') != 'linux' or config.get('architecture') != 'amd64' or len(config.get('rootfs', {}).get('diff_ids', [])) != len(saved['Layers']):
            raise ValueError('Invalid cache image config')
        config_descriptor = store_bytes(config_bytes, 'application/vnd.oci.image.config.v1+json')
        layers = []
        for name in saved['Layers']:
            digest = hashlib.sha256()
            size = 0
            pending = blobs / 'pending'
            with member_file(name, MAX_BYTES) as stream, pending.open('wb') as output:
                first = stream.read(1024 * 1024)
                media_type = 'application/vnd.oci.image.layer.v1.tar' + ('+gzip' if first[:2] == b'\x1f\x8b' else '')
                chunk = first
                while chunk:
                    size += len(chunk)
                    total += len(chunk)
                    if total > MAX_BYTES:
                        raise ValueError('Cache image exceeds 512 MiB')
                    digest.update(chunk)
                    output.write(chunk)
                    chunk = stream.read(1024 * 1024)
            pending.replace(blobs / digest.hexdigest())
            layers.append({'mediaType': media_type, 'digest': 'sha256:' + digest.hexdigest(), 'size': size})
        image_manifest = {'schemaVersion': 2, 'mediaType': 'application/vnd.oci.image.manifest.v1+json',
                          'config': config_descriptor, 'layers': layers}
        descriptor = store_bytes(json.dumps(image_manifest).encode(), image_manifest['mediaType'])
        descriptor['annotations'] = {'org.opencontainers.image.ref.name': 'latest'}
        (destination / 'index.json').write_text(json.dumps({'schemaVersion': 2, 'manifests': [descriptor]}))
        (destination / 'oci-layout').write_text('{"imageLayoutVersion":"1.0.0"}')


if __name__ == '__main__':
    prepare_cache(sys.argv[1], sys.argv[2])
