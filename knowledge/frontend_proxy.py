"""Optional, explicitly trusted frontend proxy; never trust forwarded host headers."""
from urllib.parse import urlsplit


def frontend_configuration(values):
    origin = (values.get('FRONTEND_ORIGIN') or '').rstrip('/')
    secret = values.get('FRONTEND_PROXY_SECRET') or ''
    if not origin and not secret:
        return {}
    parsed = urlsplit(origin)
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.path or parsed.query or
            parsed.fragment or parsed.username or parsed.password):
        raise ValueError('FRONTEND_ORIGIN must be the HTTPS origin of the frontend.')
    if len(secret) < 32 or not secret.isascii():
        raise ValueError('FRONTEND_PROXY_SECRET must contain at least 32 ASCII characters.')
    if values.get('PUBLIC_AUTH_MODE', 'google') != 'google':
        raise ValueError('The frontend proxy requires Google account mode.')
    return {'FRONTEND_ORIGIN': origin, 'FRONTEND_PROXY_SECRET': secret}
