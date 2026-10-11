import re
import uuid
import json


class Images:
    def __init__(self, client):
        from . import MainbrellaError
        self._error = MainbrellaError
        self._client = client
        self.tags = ImageTags(client)

    def _path(self, image_id):
        if not isinstance(image_id, str) or not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', image_id):
            raise self._error('invalid_image_identity')
        return '/images/' + image_id

    def list(self):
        return self._client.request('/images')

    def get(self, image_id):
        return self._client.request(self._path(image_id))

    def logs(self, image_id):
        return self._client.request(self._path(image_id) + '/logs')

    def delete(self, image_id):
        return self._client.request(self._path(image_id), 'DELETE')

    def create(self, name, dockerfile, context=None, *, cache_from=None, base_image=None):
        if (not isinstance(name, str) or not name.strip() or len(name.strip()) > 80 or not isinstance(dockerfile, str)
                or context is not None and (not isinstance(context, bytes) or len(context) > 512 * 1024)):
            raise self._error('invalid_image_source')
        boundary = 'mainbrella-' + uuid.uuid4().hex
        fields = []
        values = [('name', name), ('dockerfile', dockerfile)]
        if cache_from is not None:
            self._path(cache_from)
            values.append(('cacheFrom', cache_from))
        if base_image is not None:
            if (not isinstance(base_image, dict) or not isinstance(base_image.get('image'), str)
                    or set(base_image) - {'image', 'username', 'password'}
                    or ('username' in base_image) != ('password' in base_image)
                    or 'username' in base_image and (not isinstance(base_image['username'], str)
                                                     or not isinstance(base_image['password'], str))):
                raise self._error('invalid_image_source')
            values.append(('baseImage', json.dumps(base_image)))
        for key, value in values:
            fields.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n'.encode()
                          + value.encode() + b'\r\n')
        if context is not None:
            fields.append(f'--{boundary}\r\nContent-Disposition: form-data; name="context"; filename="context.tar.gz"\r\n'
                          'Content-Type: application/gzip\r\n\r\n'.encode() + context + b'\r\n')
        fields.append(f'--{boundary}--\r\n'.encode())
        return self._client.request('/images', 'POST', b''.join(fields),
                                    {'Content-Type': 'multipart/form-data; boundary=' + boundary})


class ImageTags:
    def __init__(self, client):
        from . import MainbrellaError
        self._error = MainbrellaError
        self._client = client

    def _path(self, tag):
        if not isinstance(tag, str) or not re.fullmatch(r'[a-z0-9][a-z0-9._-]{0,63}', tag):
            raise self._error('invalid_image_tag')
        return '/images/tags/' + tag

    def list(self):
        return self._client.request('/images/tags')

    def get(self, tag):
        return self._client.request(self._path(tag))

    def set(self, tag, image_id):
        Images(self._client)._path(image_id)
        return self._client.request(self._path(tag), 'PUT', {'imageId': image_id})

    def delete(self, tag):
        return self._client.request(self._path(tag), 'DELETE')
