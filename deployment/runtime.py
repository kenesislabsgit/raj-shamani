"""Load server secrets through the instance role, then start the ASGI app."""
import json
import logging
import os

import boto3
import uvicorn


def main():
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(name)s %(levelname)s %(message)s')
    # The service environment contains only the ARN, never provider credentials.
    response = boto3.client('secretsmanager', region_name=os.environ['AWS_REGION']).get_secret_value(
        SecretId=os.environ['APP_SECRET_ARN'])
    settings = json.loads(response['SecretString'])
    allowed = {'OPENAI_API_KEY', 'SUPERMEMORY_API_KEY', 'OPENAI_CHAT_MODEL', 'PUBLIC_BASE_URL',
               'COGNITO_POOL_ID', 'COGNITO_CLIENT_ID', 'COGNITO_DOMAIN', 'ORIGIN_SECRET',
               'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET',
               'FRONTEND_ORIGIN', 'FRONTEND_PROXY_SECRET',
               'MAX_CONCURRENT_ANSWERS', 'QUESTIONS_PER_USER_DAY', 'QUESTIONS_PER_DAY', 'PUBLIC_AUTH_MODE'}
    for key in allowed:
        if key in settings:
            if not isinstance(settings[key], str):
                raise ValueError('Invalid deployment setting type.')
            os.environ[key] = settings[key]
    # No access logs: authentication callback query strings must not be logged.
    uvicorn.run('knowledge.public_server:create_app', factory=True, host='0.0.0.0', port=8000,
                workers=1, proxy_headers=False, access_log=False, limit_concurrency=100,
                timeout_keep_alive=5, timeout_graceful_shutdown=310)


if __name__ == '__main__':
    main()
