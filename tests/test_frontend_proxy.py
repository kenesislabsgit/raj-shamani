import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock
from urllib.parse import parse_qs, urlsplit

from starlette.testclient import TestClient

from deployment.aws_deploy import auth_configuration, provider_configuration
from knowledge.frontend_proxy import frontend_configuration
from knowledge.google_auth import Google
from knowledge.public_server import create_app, LOGIN_COOKIE, SESSION_COOKIE

BASE = 'https://reader.example.test'
FRONTEND = 'https://frontend.example.test'
ORIGIN_SECRET = 'synthetic-cloudfront-origin-secret-32'
PROXY_SECRET = 'synthetic-vercel-proxy-secret-32-characters'
GOOGLE = {'GOOGLE_CLIENT_ID': 'test.apps.googleusercontent.com', 'GOOGLE_CLIENT_SECRET': 'synthetic-google'}
PROXY = {'FRONTEND_ORIGIN': FRONTEND, 'FRONTEND_PROXY_SECRET': PROXY_SECRET}


class FrontendProxyTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.identity, self.frontend_identity = [Google(**{
            'client_id': GOOGLE['GOOGLE_CLIENT_ID'], 'client_secret': GOOGLE['GOOGLE_CLIENT_SECRET'],
            'base_url': origin}) for origin in (BASE, FRONTEND)]
        for provider in (self.identity, self.frontend_identity):
            provider.exchange = Mock(side_effect=lambda code, *_: {
                'owner_id': 'google-' + code, 'email': code + '@example.test', 'seconds': 3600})
        answer = Mock(return_value={'status': 'insufficient_evidence', 'points': [],
                                   'recommendations': [], 'message': 'No matching evidence.'})
        library = lambda: SimpleNamespace(store=object(), llm=SimpleNamespace(model_name='fixture'),
            answer=answer, ready_videos=lambda: [{'id': 'Y566_T-YlNQ'}], close=lambda: None)
        self.app = create_app({'PUBLIC_AUTH_MODE': 'google', 'PUBLIC_BASE_URL': BASE,
            'DATA_DIR': directory.name, 'ORIGIN_SECRET': ORIGIN_SECRET, **GOOGLE, **PROXY},
            library_factory=library, identity=self.identity, frontend_identity=self.frontend_identity)
        self.direct = self.client()
        self.proxy = self.client(proxy=True)

    def client(self, proxy=False):
        headers = {'X-Reader-Origin': ORIGIN_SECRET}
        if proxy:
            headers['X-Reader-Proxy-Secret'] = PROXY_SECRET
        context = TestClient(self.app, base_url=BASE, headers=headers, follow_redirects=False)
        client = context.__enter__()
        self.addCleanup(context.__exit__, None, None, None)
        return client

    def signin(self, client, user='alice', frontend=True):
        response = client.get('/auth/login', params={'next': '/#saved/history'})
        query = parse_qs(urlsplit(response.headers['location']).query)
        self.assertEqual(query['redirect_uri'], [(FRONTEND if frontend else BASE) + '/auth/callback'])
        callback = client.get('/auth/callback', params={'state': query['state'][0], 'code': user})
        self.assertEqual(callback.status_code, 303)
        self.assertEqual(callback.headers['location'], '/#saved/history')
        self.assertIn('HttpOnly', callback.headers['set-cookie'])
        self.assertNotIn('Domain=', callback.headers['set-cookie'])
        current = client.get('/api/account').json()
        client.headers.update({'X-Account-ID': current['id'], 'X-CSRF-Token': current['csrf'],
                               'Origin': FRONTEND if frontend else BASE})
        return current

    def test_cloudfront_and_frontend_use_their_own_google_callback_and_logout(self):
        self.signin(self.proxy)
        self.frontend_identity.exchange.assert_called_once()
        self.identity.exchange.assert_not_called()
        self.signin(self.direct, frontend=False)
        self.identity.exchange.assert_called_once()
        self.assertEqual(self.proxy.post('/auth/logout').json()['redirect'], FRONTEND + '/signed-out')
        self.assertEqual(self.direct.post('/auth/logout').json()['redirect'], BASE + '/signed-out')

    def test_proxy_does_not_bypass_login_account_ownership_or_csrf(self):
        self.assertEqual(self.proxy.get('/').headers['location'], '/sign-in')
        self.assertEqual(self.proxy.get('/api/account').status_code, 401)
        self.signin(self.proxy)
        self.assertIn('data-accounts="required"', self.proxy.get('/').text)
        collection = {'revision': 0, 'items': [{'id': 'private', 'name': 'Private saves', 'items': []}]}
        self.assertEqual(self.proxy.put('/api/collections', json=collection, headers={'Origin': BASE}).status_code, 403)
        self.assertEqual(self.proxy.put('/api/collections', json=collection, headers={'X-CSRF-Token': ''}).status_code, 403)
        self.assertEqual(self.proxy.put('/api/collections', json=collection).status_code, 200)
        record = self.proxy.post('/api/ask', json={'question': 'Private question'}).json()['record_id']
        self.signin(self.direct, frontend=False)
        self.assertIn('Private saves', self.direct.get('/api/collections').text)
        self.assertEqual(self.direct.get('/api/responses/' + record).status_code, 200)
        self.signin(self.direct, user='bob', frontend=False)
        self.assertNotIn('Private saves', self.direct.get('/api/collections').text)
        self.assertEqual(self.direct.get('/api/responses/' + record).status_code, 404)
        self.assertEqual(self.proxy.get('/api/collections', headers={'X-Account-ID': 'google-bob'}).status_code, 409)
        self.assertEqual(self.proxy.get('/api/collections').headers['cache-control'], 'no-store')

    def test_missing_wrong_and_spoofed_proxy_headers_cannot_select_frontend(self):
        for secret in ('', 'wrong'):
            self.assertEqual(self.proxy.get('/auth/login', headers={'X-Reader-Proxy-Secret': secret}).status_code, 403)
        response = self.direct.get('/auth/login', headers={'X-Forwarded-Host': 'evil.example',
            'X-Forwarded-Proto': 'https', 'X-Reader-Frontend': FRONTEND})
        self.assertEqual(parse_qs(urlsplit(response.headers['location']).query)['redirect_uri'], [BASE + '/auth/callback'])
        self.assertEqual(self.proxy.get('/', headers={'Host': 'evil.example'}).status_code, 403)
        self.assertEqual(self.proxy.get('/', headers={'X-Reader-Origin': 'wrong'}).status_code, 403)

    def test_login_attempt_cannot_move_between_origins_even_with_copied_state_cookie(self):
        response = self.proxy.get('/auth/login')
        state = parse_qs(urlsplit(response.headers['location']).query)['state'][0]
        self.direct.cookies.set(LOGIN_COOKIE, state)
        response = self.direct.get('/auth/callback', params={'state': state, 'code': 'alice'})
        self.assertEqual(response.status_code, 400)
        self.identity.exchange.assert_not_called()
        self.frontend_identity.exchange.assert_not_called()
        self.assertNotIn(SESSION_COOKIE, self.direct.cookies)

    def test_frontend_configuration_is_optional_and_credentials_are_paired(self):
        self.assertEqual(frontend_configuration({}), {})
        self.assertEqual(auth_configuration({**GOOGLE, **PROXY})['FRONTEND_ORIGIN'], FRONTEND)
        for partial in ({'FRONTEND_ORIGIN': FRONTEND}, {'FRONTEND_PROXY_SECRET': PROXY_SECRET}):
            with self.assertRaises(ValueError):
                frontend_configuration(provider_configuration(partial, PROXY))
        for origin in ('http://frontend.test', FRONTEND + '/path', FRONTEND + '?q=1',
                       FRONTEND + '#fragment', 'https://user:password@frontend.test'):
            with self.assertRaises(ValueError):
                frontend_configuration({**PROXY, 'FRONTEND_ORIGIN': origin})
        with self.assertRaises(ValueError):
            frontend_configuration({**PROXY, 'PUBLIC_AUTH_MODE': 'guest'})


if __name__ == '__main__':
    unittest.main()
