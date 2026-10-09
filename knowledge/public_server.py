"""Production ASGI reader: browser sessions, isolated data and bounded paid work.

Run behind the deployment's CloudFront VPC origin with a single Uvicorn worker.
The loopback-only development server remains available separately.
"""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
import hmac
from html import escape
import ipaddress
import json
import logging
import os
from pathlib import Path
import queue
import re
import threading
import time
from urllib.parse import urlencode, urlsplit

from starlette.applications import Starlette
from starlette.concurrency import run_in_threadpool
from starlette.exceptions import HTTPException
from starlette.requests import Request
from starlette.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, StreamingResponse
from starlette.routing import Route

from .accounts import Accounts, CollectionConflict, GUEST_SESSION_SECONDS, UsageLimit
from .cognito_auth import Cognito
from .google_auth import Google
from .frontend_proxy import frontend_configuration
from .raj_library import RajShamaniLibrary
from .response_history import ResponseHistory
from .server import STATIC, recorded_answer

SESSION_COOKIE = '__Host-reader-session'
GUEST_COOKIE = '__Host-reader-guest'
LOGIN_COOKIE = '__Host-reader-login'
LOG = logging.getLogger('knowledge.public')
ASSETS = {
    '/reader.js': 'reader.js', '/reader.css': 'reader.css', '/theme.js': 'theme.js', '/sign-in.js': 'sign-in.js',
    '/catalog.json': 'catalog.json', '/favicon.svg': 'favicon.svg',
    '/geist-latin.woff2': 'geist-latin.woff2', '/media/huberman.png': 'media/huberman.png',
    '/media/raj-shamani.jpg': 'media/raj-shamani.jpg',
    '/media/google-g.png': 'media/google-g.png',
    '/google-sans.ttf': 'google-sans.ttf',
}


class SessionChanged(HTTPException):
    def __init__(self):
        super().__init__(409, 'Your browser session changed. Reload this page to continue.')


def reader_return_path(value):
    """Only permit known reader routes; never redirect sign-in to another site."""
    return value if isinstance(value, str) and re.fullmatch(
        r'/(?:#(?:discover|conversations|saved(?:/history)?|answer(?:/[a-f0-9]{32})?))?', value) else '/'


def sign_in_page(*, mode='google', signup=False, signed_out=False, error=None, return_to='/'):
    page = (STATIC / 'sign-in.html').read_text(encoding='utf-8')
    if signup:
        page = page.replace('Sign in.</h1>', 'Create an account.</h1>')
        page = page.replace('Access your saved questions and collections.', 'Save questions and clips to your account.')
        page = page.replace('New here?', 'Already have an account?')
        page = page.replace('href="/sign-up">Create an account', 'href="/sign-in">Sign in')
        page = page.replace('Sign in — Figuring Out', 'Create an account — Figuring Out')
    if signed_out:
        page = page.replace('Sign in.</h1>', 'You’re signed out.</h1>')
    if mode == 'cognito':
        page = page.replace('data-provider="google"', 'data-provider="cognito"')
        page = page.replace('Continue with Google', 'Continue with email')
    if error:
        message = {'cancelled': 'Sign-in was cancelled. You can try again.',
                   'expired': 'This sign-in attempt expired. Please try again.'}.get(error, 'Sign-in could not finish. Please try again.')
        page = page.replace('role="alert" hidden></p>', 'role="alert">' + message + '</p>')
    # Server fallback also preserves routes when JavaScript is unavailable.
    query = escape(urlencode({'next': reader_return_path(return_to)}), quote=True)
    for path in ('/auth/login', '/sign-in', '/sign-up'):
        page = page.replace(f'href="{path}"', f'href="{path}?{query}"')
    return page


SECURITY_HEADERS = {
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', 'Strict-Transport-Security': 'max-age=31536000',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' https://www.youtube.com https://s.ytimg.com; style-src 'self'; img-src 'self' https://i.ytimg.com; frame-src https://www.youtube-nocookie.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
}


class PublicBoundary:
    def __init__(self, app, *, host, origin_secret, public_origin, frontend=None):
        self.app, self.host, self.secret = app, host, origin_secret
        self.public_origin, self.frontend = public_origin, frontend or {}

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            return await self.app(scope, receive, send)
        request = Request(scope)
        if (request.headers.get('host', '').lower() != self.host or
                not hmac.compare_digest(request.headers.get('x-reader-origin', ''), self.secret)):
            return await JSONResponse({'error': 'This address is unavailable.'}, 403, headers=SECURITY_HEADERS)(scope, receive, send)

        # CloudFront still authenticates the origin connection. A separate proxy
        # credential selects the one configured frontend; arbitrary Host/XFH
        # values can never choose OAuth callbacks or relax Origin validation.
        proxy_secret = request.headers.get('x-reader-proxy-secret')
        scope['reader.public_origin'] = self.public_origin
        if proxy_secret is not None:
            expected = self.frontend.get('FRONTEND_PROXY_SECRET', '')
            if not expected or not hmac.compare_digest(proxy_secret.encode(), expected.encode()):
                return await JSONResponse({'error': 'Frontend connection is not configured.'}, 403, headers=SECURITY_HEADERS)(scope, receive, send)
            scope['reader.public_origin'] = self.frontend['FRONTEND_ORIGIN']

        async def secured_send(message):
            if message['type'] == 'http.response.start':
                values = {k.lower().encode(): v.encode() for k, v in SECURITY_HEADERS.items()}
                message['headers'] = [(k, v) for k, v in message.get('headers', []) if k.lower() not in values]
                message['headers'].extend(values.items())
            await send(message)
        await self.app(scope, receive, secured_send)


class Admission:
    def __init__(self, maximum):
        self.maximum = maximum
        self.users = set()
        self.lock = threading.Lock()

    def acquire(self, owner):
        with self.lock:
            if owner in self.users or len(self.users) >= self.maximum:
                return False
            self.users.add(owner)
            return True

    def release(self, owner):
        with self.lock:
            self.users.discard(owner)


class LoginLimiter:
    def __init__(self):
        self.entries = {}
        self.lock = threading.Lock()

    def check(self, address, message='Too many sign-in attempts. Please wait a minute.'):
        now = time.monotonic()
        with self.lock:
            self.entries = {key: value for key, value in self.entries.items() if value[0] > now - 60}
            started, count = self.entries.get(address, (now, 0))
            if count >= 10 or len(self.entries) >= 10000:
                raise HTTPException(429, message)
            self.entries[address] = (started, count + 1)


def create_app(config=None, *, library_factory=None, identity=None, frontend_identity=None):
    config = dict(os.environ if config is None else config)
    auth_mode = config.get('PUBLIC_AUTH_MODE', 'google')
    if auth_mode not in {'guest', 'cognito', 'google'}:
        raise ValueError('PUBLIC_AUTH_MODE must be google, guest or cognito.')
    guest_mode = auth_mode == 'guest'
    cookie_name = GUEST_COOKIE if guest_mode else SESSION_COOKIE
    base_url = config.get('PUBLIC_BASE_URL', '').rstrip('/')
    parsed = urlsplit(base_url)
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.path or parsed.query or
            parsed.fragment or parsed.username or parsed.password):
        raise ValueError('PUBLIC_BASE_URL must be the HTTPS origin of this deployment.')
    secret = config.get('ORIGIN_SECRET', '')
    if len(secret) < 32:
        raise ValueError('A random ORIGIN_SECRET of at least 32 characters is required.')
    frontend = frontend_configuration(config)
    if frontend.get('FRONTEND_ORIGIN') == base_url:
        raise ValueError('FRONTEND_ORIGIN must differ from the AWS origin.')
    data = Path(config['DATA_DIR'])
    accounts = Accounts(data / 'accounts.sqlite3')
    history = ResponseHistory(data / 'responses.sqlite3')
    if auth_mode == 'google':
        identity = identity or Google(client_id=config.get('GOOGLE_CLIENT_ID', ''),
                                      client_secret=config.get('GOOGLE_CLIENT_SECRET', ''), base_url=base_url)
    elif not guest_mode:
        identity = identity or Cognito(region=config['AWS_REGION'], pool_id=config['COGNITO_POOL_ID'],
                                      client_id=config['COGNITO_CLIENT_ID'], domain=config['COGNITO_DOMAIN'], base_url=base_url)
    if frontend:
        frontend_identity = frontend_identity or Google(client_id=config.get('GOOGLE_CLIENT_ID', ''),
            client_secret=config.get('GOOGLE_CLIENT_SECRET', ''), base_url=frontend['FRONTEND_ORIGIN'])

    def identity_for(request):
        return frontend_identity if request.scope['reader.public_origin'] != base_url else identity
    if library_factory is None:
        for key in ('OPENAI_API_KEY', 'SUPERMEMORY_API_KEY'):
            if not config.get(key):
                raise ValueError(f'{key} is required for this deployment.')
        library_factory = lambda: RajShamaniLibrary(data)
    maximum = int(config.get('MAX_CONCURRENT_ANSWERS', '2'))
    daily, global_daily = int(config.get('QUESTIONS_PER_USER_DAY', '20')), int(config.get('QUESTIONS_PER_DAY', '200'))
    if not 1 <= maximum <= 8 or not 1 <= daily <= global_daily <= 10000:
        raise ValueError('Invalid answer capacity or daily limits.')
    admission = Admission(maximum)
    executor = ThreadPoolExecutor(max_workers=maximum, thread_name_prefix='reader-answer')
    login_limiter = LoginLimiter()

    @asynccontextmanager
    async def lifespan(app):
        yield
        await asyncio.to_thread(executor.shutdown, wait=True)

    def client_address(request):
        if frontend and request.scope['reader.public_origin'] == frontend['FRONTEND_ORIGIN']:
            # Vercel overwrites x-real-ip; trust it only after verifying its proxy key.
            address = request.headers.get('x-real-ip', '')
            try:
                return str(ipaddress.ip_address(address))
            except ValueError:
                pass
        # The VPC origin accepts CloudFront only. It appends the real viewer IP last.
        address = request.headers.get('x-forwarded-for', '').split(',')[-1].strip()
        try:
            return str(ipaddress.ip_address(address))
        except ValueError:
            return request.client.host if request.client else 'unknown'

    def network_id(request):
        address = client_address(request)
        return hmac.new(secret.encode(), address.encode(), 'sha256').hexdigest()

    def current_session(request):
        current = accounts.session(request.cookies.get(cookie_name))
        if current and current['owner_id'].startswith('guest-') != guest_mode:
            return None
        if current and not guest_mode and current['owner_id'].startswith('google-') != (auth_mode == 'google'):
            return None
        return current

    def guest_session(request):
        current = current_session(request)
        if current:
            return current, None
        login_limiter.check(network_id(request), 'Too many new browser sessions. Please wait a minute.')
        token = accounts.create_guest_session()
        return accounts.session(token), token

    def guest_cookie(response, token):
        if token:
            response.set_cookie(GUEST_COOKIE, token, max_age=GUEST_SESSION_SECONDS,
                                secure=True, httponly=True, samesite='lax')
        return response

    def session(request, *, mutation=False, bind_account=True):
        current = current_session(request)
        if current is None:
            raise HTTPException(401, 'Your browser session expired. Reload this page to continue.' if guest_mode else 'Sign in to use your account.')
        if bind_account and request.headers.get('x-account-id') != current['owner_id']:
            raise SessionChanged()
        if mutation and (request.headers.get('origin') != request.scope['reader.public_origin'] or
                         not hmac.compare_digest(request.headers.get('x-csrf-token', ''), current['csrf'])):
            raise HTTPException(403, 'Your session could not be verified. Reload this page and try again.')
        return current

    async def read_json(request, maximum=32768):
        if request.headers.get('content-type', '').split(';')[0] != 'application/json':
            raise HTTPException(400, 'Send a JSON request.')
        async def read():
            body = bytearray()
            async for chunk in request.stream():
                body.extend(chunk)
                if len(body) > maximum:
                    raise HTTPException(413, 'This request is too large.')
            try:
                result = json.loads(body)
                if not isinstance(result, dict):
                    raise ValueError()
                return result
            except (ValueError, UnicodeError, RecursionError):
                raise HTTPException(400, 'Send a valid JSON object.') from None
        try:
            return await asyncio.wait_for(read(), 15)
        except TimeoutError:
            raise HTTPException(408, 'The request took too long to upload.') from None

    def homepage(request):
        token = None
        if guest_mode:
            _, token = guest_session(request)
        elif current_session(request) is None:
            return RedirectResponse('/sign-in', 303)
        mode = 'guest' if guest_mode else 'required'
        return guest_cookie(HTMLResponse((STATIC / 'index.html').read_text(encoding='utf-8').replace(
            'data-accounts="local"', f'data-accounts="{mode}"')), token)

    def sign_in(request):
        if guest_mode:
            return RedirectResponse('/', 303)
        # A fresh shell also preserves the hash in an opened saved-answer link.
        # Never include private application content on this public page.
        if current_session(request):
            return RedirectResponse(reader_return_path(request.query_params.get('next')), 303)
        return HTMLResponse(sign_in_page(mode=auth_mode, signup=request.url.path == '/sign-up',
            error=request.query_params.get('error'), return_to=request.query_params.get('next')))

    def login(request):
        if guest_mode:
            return RedirectResponse('/', 303)
        login_limiter.check(client_address(request))
        state, verifier, nonce = accounts.begin_login(reader_return_path(request.query_params.get('next')),
                                                      public_origin=request.scope['reader.public_origin'])
        response = RedirectResponse(identity_for(request).login_url(state, verifier, nonce), 303)
        response.set_cookie(LOGIN_COOKIE, state, max_age=600, secure=True, httponly=True, samesite='lax')
        return response

    def callback(request):
        if guest_mode:
            return RedirectResponse('/', 303)
        state = request.query_params.get('state', '')
        cookie = request.cookies.get(LOGIN_COOKIE, '')
        if not state or len(state) > 200 or not cookie or not hmac.compare_digest(state, cookie):
            raise HTTPException(400, 'Sign-in expired or could not be verified. Start again.')
        attempt = accounts.consume_login(state)
        code = request.query_params.get('code', '')
        if not attempt:
            raise HTTPException(400, 'Sign-in expired or was cancelled. Start again.')
        if (attempt.get('public_origin') or base_url) != request.scope['reader.public_origin']:
            raise HTTPException(400, 'Start sign-in again on this website.')
        def retry(reason):
            response = RedirectResponse('/sign-in?' + urlencode({'error': reason,
                'next': reader_return_path(attempt.get('return_to'))}), 303)
            response.delete_cookie(LOGIN_COOKIE, secure=True, httponly=True, samesite='lax')
            return response
        if request.query_params.get('error'):
            return retry('cancelled' if request.query_params['error'] == 'access_denied' else 'failed')
        if not code or len(code) > 4096:
            return retry('expired')
        try:
            claims = identity_for(request).exchange(code, attempt['verifier'], attempt['nonce'])
            token = accounts.create_session(**claims)
        except Exception:
            LOG.warning('Sign-in exchange failed; provider details omitted')
            return retry('failed')
        response = RedirectResponse(reader_return_path(attempt.get('return_to')), 303)
        response.delete_cookie(LOGIN_COOKIE, secure=True, httponly=True, samesite='lax')
        old_token = request.cookies.get(SESSION_COOKIE)
        if old_token:
            accounts.logout(old_token)
        response.set_cookie(SESSION_COOKIE, token, max_age=claims['seconds'], secure=True, httponly=True, samesite='lax')
        return response

    def account(request):
        current, token = guest_session(request) if guest_mode else (session(request, bind_account=False), None)
        return guest_cookie(JSONResponse({'id': current['owner_id'], 'email': current['email'],
                                         'csrf': current['csrf'], 'mode': auth_mode}), token)

    def logout(request):
        session(request, mutation=True)
        accounts.logout(request.cookies[cookie_name])
        response = JSONResponse({'redirect': '/' if guest_mode else identity_for(request).logout_url()})
        response.delete_cookie(cookie_name, secure=True, httponly=True, samesite='lax')
        return response

    def signed_out(request):
        if guest_mode:
            return RedirectResponse('/', 303)
        return HTMLResponse(sign_in_page(mode=auth_mode, signed_out=True))

    def assets(request):
        filename = ASSETS.get(request.url.path)
        if filename is None:
            raise HTTPException(404, 'Not found.')
        return FileResponse(STATIC / filename)

    def health(request):
        if request.url.path == '/health/ready':
            library = library_factory()
            try:
                ready = library.ready_videos()
                if not ready or not all((library.directory / f"{v['id']}-{v['revision'][:12]}.json").is_file() for v in ready):
                    return JSONResponse({'ok': False}, 503)
                with accounts.connect() as db:
                    db.execute('SELECT 1').fetchone()
            finally:
                library.close()
        return JSONResponse({'ok': True})

    def status(request):
        session(request)
        library = library_factory()
        try:
            return JSONResponse(library.status())
        finally:
            library.close()

    def videos(request):
        session(request)
        library = library_factory()
        try:
            return JSONResponse({'sources': library.page(int(request.query_params.get('offset', '0')), status='ready')})
        finally:
            library.close()

    def responses(request):
        record_id = request.path_params.get('record_id')
        # Direct download links have no custom headers; ownership still gates every ID.
        owner = session(request, bind_account=not bool(record_id))['owner_id']
        scoped = history.for_owner(owner)
        if record_id:
            record = scoped.get(record_id)
            if record is None:
                raise HTTPException(404, 'Saved response not found.')
            # Match fresh answers while keeping diagnostic references on disk.
            record.get('response', {}).pop('diagnostic_id', None)
            return JSONResponse(record)
        return JSONResponse(scoped.list(offset=int(request.query_params.get('offset', '0'))))

    async def collections(request):
        current = await run_in_threadpool(session, request, mutation=request.method == 'PUT')
        if request.method == 'GET':
            return JSONResponse(await run_in_threadpool(accounts.collections, current['owner_id']))
        body = await read_json(request, 2_000_000)
        return JSONResponse(await run_in_threadpool(accounts.save_collections, current['owner_id'], body.get('revision'), body.get('items')))

    async def ask(request):
        current = await run_in_threadpool(session, request, mutation=True)
        body = await read_json(request)
        question = body.get('question')
        if not isinstance(question, str) or not question.strip() or len(question) > 6000:
            raise HTTPException(400, 'Enter a question of up to 6,000 characters.')
        source_id = body.get('source_id')
        if source_id is not None and not isinstance(source_id, str):
            raise HTTPException(400, 'Selected video is not ready to search.')
        # Reject bad scopes before reserving budget or paying a provider.
        def valid_scope():
            library = library_factory()
            try:
                if source_id is not None and source_id not in {v['id'] for v in library.ready_videos()}:
                    raise ValueError('Selected video is not ready to search.')
            finally:
                library.close()
        await run_in_threadpool(valid_scope)
        owner = current['owner_id']
        if not admission.acquire(owner):
            raise HTTPException(429, 'The archive is preparing other answers. Please try again shortly.', headers={'Retry-After': '10'})
        events = queue.SimpleQueue()

        def generate():
            started = time.monotonic()
            library = None
            try:
                library = library_factory()
                def progress(event):
                    if event.get('type') == 'stage' and isinstance(event.get('message'), str):
                        stage = {'type': 'stage', 'message': event['message']}
                        if event.get('phase') in ('search', 'review', 'compose'):
                            stage['phase'] = event['phase']
                        events.put(stage)
                result, code = recorded_answer(library, history.for_owner(owner),
                                               {'question': question, 'source_id': source_id}, progress=progress)
                # Diagnostics remain private on disk and are never downloadable by users.
                result.pop('diagnostic_id', None)
                events.put({'type': 'answer', 'response': result, 'http_status': code})
                LOG.info('answer_completed status=%s seconds=%.2f', result.get('status', 'error'), time.monotonic() - started)
                return result, code
            except Exception:
                LOG.error('answer_failed before response recording; details omitted')
                result = {'error': 'The request could not finish. Please try again.'}
                events.put({'type': 'answer', 'response': result, 'http_status': 500})
                return result, 500
            finally:
                if library is not None:
                    library.close()
                admission.release(owner)
        try:
            await run_in_threadpool(accounts.reserve_question, owner, daily, global_daily,
                                    network_id=network_id(request) if guest_mode else None)
            future = executor.submit(generate)
        except BaseException:
            admission.release(owner)
            raise
        if request.url.path == '/api/ask':
            result, code = await asyncio.shield(asyncio.wrap_future(future))
            return JSONResponse(result, code)

        async def stream():
            while True:
                try:
                    event = await asyncio.to_thread(events.get, True, 10)
                except queue.Empty:
                    # Keep the proxy connection active during longer provider checks.
                    yield '\n'
                    continue
                yield json.dumps(event, ensure_ascii=False) + '\n'
                if event['type'] == 'answer':
                    break
        return StreamingResponse(stream(), media_type='application/x-ndjson', headers={'X-Accel-Buffering': 'no'})

    async def error_response(request, exc):
        code = exc.status_code if isinstance(exc, HTTPException) else (
            409 if isinstance(exc, CollectionConflict) else 429 if isinstance(exc, UsageLimit) else 400 if isinstance(exc, ValueError) else 500)
        message = exc.detail if isinstance(exc, HTTPException) else str(exc) if code < 500 else 'The request could not finish. Please try again.'
        if request.url.path in ('/auth/login', '/auth/callback'):
            # Fixed copy; provider errors and query parameters are never reflected.
            return HTMLResponse(sign_in_page(mode=auth_mode, error='expired' if code == 400 else 'failed'), code)
        body = {'error': message}
        if isinstance(exc, SessionChanged):
            body['code'] = 'session_changed'
        return JSONResponse(body, code, headers=getattr(exc, 'headers', None))

    routes = [Route('/', homepage), Route('/sign-in', sign_in), Route('/sign-up', sign_in), Route('/auth/login', login), Route('/auth/callback', callback),
              Route('/signed-out', signed_out), Route('/api/account', account),
              Route('/auth/logout', logout, methods=['POST']), Route('/api/status', status), Route('/api/videos', videos),
              Route('/api/responses', responses), Route('/api/responses/{record_id}', responses),
              Route('/api/collections', collections, methods=['GET', 'PUT']),
              Route('/api/ask/stream', ask, methods=['POST']), Route('/api/ask', ask, methods=['POST']),
              Route('/health/live', health), Route('/health/ready', health)]
    routes.extend(Route(path, assets) for path in ASSETS)
    app = Starlette(routes=routes, lifespan=lifespan,
                    exception_handlers={HTTPException: error_response, ValueError: error_response, Exception: error_response})
    app.add_middleware(PublicBoundary, host=parsed.netloc.lower(), origin_secret=secret,
                       public_origin=base_url, frontend=frontend)
    app.state.accounts = accounts
    app.state.history = history
    app.state.admission = admission
    return app
