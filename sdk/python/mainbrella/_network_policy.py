"""Canonical policy comparison matching the API's domain and CIDR rules."""
import ipaddress
import re


def normalize_network_policy(policy):
    if not isinstance(policy, dict) or set(policy) - {'allow', 'deny'}:
        return None
    result = {}
    for field in ('allow', 'deny'):
        entries = policy.get(field, [] if field == 'deny' else None)
        if not isinstance(entries, list) or len(entries) > 64:
            return None
        rules = []
        for entry in entries:
            if not isinstance(entry, str) or entry != entry.strip():
                return None
            entry = entry.lower()
            if entry == '*':
                rules.append(entry)
                continue
            address, separator, prefix = entry.partition('/')
            try:
                # The API accepts brackets for individual IPv6 addresses too.
                ip = ipaddress.ip_address(address.removeprefix('[').removesuffix(']'))
            except ValueError:
                host = entry.removeprefix('*.')
                if (len(host) > 253 or not re.fullmatch(r'(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z](?:[a-z\d-]{0,61}[a-z\d])?', host, re.ASCII)
                        or re.search(r'(?:^|\.)(?:localhost|local|internal|invalid|test|example|onion)$', host)):
                    return None
                rules.append(entry)
                continue
            if '%' in address or separator and (not re.fullmatch(r'[0-9]{1,3}', prefix) or int(prefix) > ip.max_prefixlen):
                return None
            size = int(prefix) if separator else ip.max_prefixlen
            network = ipaddress.ip_network((ip, size), strict=False)
            canonical = str(network.network_address) if ip.version == 4 else ':'.join(format((int(network.network_address) >> shift) & 65535, 'x') for shift in range(112, -1, -16))
            rules.append(f'{canonical}/{size}')
        result[field] = sorted(set(rules))
    return result
