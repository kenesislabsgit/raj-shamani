"""Package locally by default; --deploy provisions and installs the AWS stack.

Reads local .env credentials or the standard AWS credential chain.
Never accepts credentials as CLI arguments or includes them in a release.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import sqlite3
import tarfile
import tempfile
import time

import boto3
from botocore.exceptions import BotoCoreError, ClientError
from dotenv import dotenv_values

from knowledge.providers import DEFAULT_OPENAI_MODEL
from knowledge.google_auth import Google
from knowledge.frontend_proxy import frontend_configuration
from .template import template

ROOT = Path(__file__).resolve().parents[1]


def provider_configuration(file_values, environ=None):
    """Explicit project settings take precedence over inherited shell values."""
    environ = os.environ if environ is None else environ
    keys = ('OPENAI_API_KEY', 'SUPERMEMORY_API_KEY', 'OPENAI_CHAT_MODEL', 'PUBLIC_AUTH_MODE')
    result = {key: value for key in keys if (value := file_values.get(key) or environ.get(key))}
    # A client ID and its secret must come from the same source, just like AWS credentials.
    for paired_keys in (('GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'), ('FRONTEND_ORIGIN', 'FRONTEND_PROXY_SECRET')):
        for source in (file_values, environ):
            if any(source.get(key) for key in paired_keys):
                result.update({key: source.get(key, '') for key in paired_keys})
                break
    return result


def auth_configuration(values):
    mode = values.get('PUBLIC_AUTH_MODE', 'google')
    if mode not in {'google', 'guest', 'cognito'}:
        raise ValueError('PUBLIC_AUTH_MODE must be google, guest or cognito.')
    result = {'PUBLIC_AUTH_MODE': mode}
    if mode == 'google':
        result.update({key: values.get(key, '') for key in ('GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET')})
        # Fail before modifying AWS settings when either credential is absent or malformed.
        Google(client_id=result['GOOGLE_CLIENT_ID'], client_secret=result['GOOGLE_CLIENT_SECRET'],
               base_url='https://reader.example.test')
    result.update(frontend_configuration(values))
    return result


def cloudfront_prefix_list(client):
    name = 'com.amazonaws.global.cloudfront.origin-facing'
    rows = []
    for page in client.get_paginator('describe_managed_prefix_lists').paginate(
            Filters=[{'Name': 'prefix-list-name', 'Values': [name]}]):
        rows.extend(item for item in page['PrefixLists']
                    if item.get('PrefixListName') == name and item.get('OwnerId') == 'AWS'
                    and item.get('AddressFamily') == 'IPv4')
    if len(rows) != 1 or not re.fullmatch(r'pl-[a-f0-9]+', rows[0].get('PrefixListId', '')):
        raise RuntimeError('Could not identify exactly one AWS-managed CloudFront IPv4 prefix list.')
    return rows[0]['PrefixListId']


def aws_session(*, profile=None, region=None, file_values=None, environ=None):
    """Keep each credential set together; never combine keys from two sources."""
    if file_values is None:
        file_values = dotenv_values(ROOT / '.env', interpolate=False)
    if environ is None:
        environ = os.environ
    kwargs = {'region_name': region or environ.get('AWS_REGION')
              or environ.get('AWS_DEFAULT_REGION') or file_values.get('AWS_REGION')
              or file_values.get('AWS_DEFAULT_REGION') or 'ap-south-1'}
    if profile:
        kwargs['profile_name'] = profile
    else:
        for source, values in [('process environment', environ), ('local .env', file_values)]:
            access = values.get('AWS_ACCESS_KEY_ID')
            secret = values.get('AWS_SECRET_ACCESS_KEY')
            token = values.get('AWS_SESSION_TOKEN')
            if not any((access, secret, token)):
                continue
            if not access or not secret:
                raise ValueError(f'Incomplete AWS credentials in {source}. Set both '
                                 'AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY together; '
                                 'include AWS_SESSION_TOKEN only for that same temporary session.')
            kwargs.update(aws_access_key_id=access, aws_secret_access_key=secret,
                          aws_session_token=token or None)
            break
    return boto3.Session(**kwargs)


def package(output):
    output.mkdir(parents=True, exist_ok=True)
    template_path = output / 'cloudformation.json'
    template_path.write_text(json.dumps(template(), indent=2) + '\n')
    bundle = output / 'reader.tar.gz'
    with tempfile.TemporaryDirectory() as directory:
        copied = Path(directory) / 'channels.sqlite3'
        with sqlite3.connect(f'file:{ROOT / "data/channels.sqlite3"}?mode=ro', uri=True) as db:
            with sqlite3.connect(copied) as destination:
                db.backup(destination)
        with tarfile.open(bundle, 'w:gz') as archive:
            for path in sorted((ROOT / 'knowledge').glob('*.py')):
                archive.add(path, arcname=path.relative_to(ROOT))
            for path in sorted((ROOT / 'knowledge/web').rglob('*')):
                if path.is_file() and path.suffix in {'.js', '.css', '.html', '.json', '.svg', '.woff2', '.ttf', '.png', '.jpg'}:
                    archive.add(path, arcname=path.relative_to(ROOT))
                elif path.is_file() and path.name.endswith('-OFL.txt'):
                    archive.add(path, arcname=path.relative_to(ROOT))
            for path in sorted((ROOT / 'deployment').iterdir()):
                if path.is_file() and path.suffix in {'.py', '.sh'}:
                    archive.add(path, arcname=path.relative_to(ROOT))
            archive.add(ROOT / 'requirements-production.txt', arcname='requirements-production.txt')
            archive.add(copied, arcname='seed-data/channels.sqlite3')
            with sqlite3.connect(copied) as db:
                rows = db.execute("SELECT v.id,v.revision FROM videos v JOIN channel_videos c ON c.video_id=v.id WHERE c.channel_id=? AND v.state='ready'",
                                  ('UCzwCEE_PchiBULMnAJqhGVg',)).fetchall()
            if not rows:
                raise RuntimeError('No ready archive exists for deployment.')
            for video_id, revision in rows:
                relative = Path('supermemory-trial/timed-captions') / f'{video_id}-{revision[:12]}.json'
                original = ROOT / 'data' / relative
                document = json.loads(original.read_text())
                if document.get('id') != video_id or document.get('revision') != revision:
                    raise RuntimeError('The caption snapshot does not match the catalog.')
                archive.add(original, arcname=Path('seed-data') / relative)
    checksum = hashlib.sha256(bundle.read_bytes()).hexdigest()
    manifest = {'sha256': checksum, 'bytes': bundle.stat().st_size, 'videos': len(rows),
                'excludes': ['credentials', 'developer answer history', 'browser collections', 'diagnostics', 'virtual environments']}
    (output / 'release.json').write_text(json.dumps(manifest, indent=2) + '\n')
    return bundle, checksum, template_path


def failure_reasons(events):
    failures = [e for e in events if 'FAILED' in e['ResourceStatus']]
    causes = [e for e in failures if 'cancelled' not in e.get('ResourceStatusReason', '').lower()]
    return [f"{e['LogicalResourceId']}: {e.get('ResourceStatusReason', e['ResourceStatus'])}"
            for e in (causes or failures)]


def report_stack(client, stack, output):
    current = client.describe_stacks(StackName=stack)['Stacks'][0]
    resources = []
    for page in client.get_paginator('list_stack_resources').paginate(StackName=current['StackId']):
        resources.extend({key: r.get(key) for key in ('LogicalResourceId', 'PhysicalResourceId',
                                                     'ResourceType', 'ResourceStatus')}
                         for r in page['StackResourceSummaries'])
    events = client.describe_stack_events(StackName=current['StackId'])['StackEvents']
    report = {'stack_id': current['StackId'], 'status': current['StackStatus'],
              'resources': resources, 'failure_reasons': failure_reasons(events),
              'outputs': {item['OutputKey']: item['OutputValue'] for item in current.get('Outputs', [])}}
    output.mkdir(parents=True, exist_ok=True)
    (output / 'aws-stack-status.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2), flush=True)


def recover_failed_stack(client, existing, output):
    """Remove only a failed initial stack record, preserving Retain resources."""
    stack_id = existing['StackId']
    if existing['StackStatus'] != 'ROLLBACK_COMPLETE':
        raise RuntimeError('Recovery requires ROLLBACK_COMPLETE. Wait for rollback or inspect the stack first.')
    if not any(t['Key'] == 'Project' and t['Value'] == 'KnowledgeReader' for t in existing.get('Tags', [])):
        raise RuntimeError('Refusing recovery of a stack not owned by KnowledgeReader.')
    resources = []
    for page in client.get_paginator('list_stack_resources').paginate(StackName=stack_id):
        resources.extend(page['StackResourceSummaries'])
    # An initial failure after the server/data disk exists needs a separate data review.
    if any(r['LogicalResourceId'] in {'Instance', 'DataVolume'} and r.get('PhysicalResourceId')
           for r in resources):
        raise RuntimeError('This failed stack created a server or data disk. Review its data before recovery.')
    old = client.get_template(StackName=stack_id)['TemplateBody']
    if isinstance(old, str):
        old = json.loads(old)
    protected = {'Storage', 'Settings', 'Users', 'AppLogs'}
    for r in resources:
        if r['LogicalResourceId'] in protected and r.get('PhysicalResourceId'):
            if old.get('Resources', {}).get(r['LogicalResourceId'], {}).get('DeletionPolicy') != 'Retain':
                raise RuntimeError('A persistent resource is missing its retention policy. Recovery stopped.')
    # Preserve the exact inventory before changing the stack, including skipped resources.
    report = {'stack_id': stack_id, 'status': existing['StackStatus'],
              'resources': [{key: r.get(key) for key in ('LogicalResourceId', 'PhysicalResourceId',
                                                       'ResourceType', 'ResourceStatus')} for r in resources]}
    output.mkdir(parents=True, exist_ok=True)
    (output / 'failed-stack-resources.json').write_text(json.dumps(report, indent=2) + '\n')
    client.update_termination_protection(StackName=stack_id, EnableTerminationProtection=False)
    client.delete_stack(StackName=stack_id)
    print('Removing the failed initial stack record. Retained resources remain preserved.', flush=True)
    deadline = time.monotonic() + 600
    while time.monotonic() < deadline:
        try:
            state = client.describe_stacks(StackName=stack_id)['Stacks'][0]['StackStatus']
        except ClientError as exc:
            if exc.response['Error']['Code'] == 'ValidationError' and 'does not exist' in exc.response['Error']['Message']:
                return
            raise
        if state == 'DELETE_COMPLETE':
            return
        if state == 'DELETE_FAILED':
            raise RuntimeError('Failed-stack cleanup needs attention. Retained resources were not removed.')
        time.sleep(5)
    raise RuntimeError('Failed-stack removal is still running. Check its status before retrying.')


def wait_stack(client, stack):
    previous = None
    deadline = time.monotonic() + 2400
    while time.monotonic() < deadline:
        current = client.describe_stacks(StackName=stack)['Stacks'][0]
        status = current['StackStatus']
        if status != previous:
            print('AWS stack: ' + status, flush=True)
            previous = status
        if status in {'CREATE_COMPLETE', 'UPDATE_COMPLETE'}:
            return {item['OutputKey']: item['OutputValue'] for item in current.get('Outputs', [])}
        if 'FAILED' in status or 'ROLLBACK' in status:
            events = client.describe_stack_events(StackName=stack)['StackEvents']
            reasons = failure_reasons(events)
            raise RuntimeError('AWS stack failed: ' + ' | '.join(reasons[:5]))
        time.sleep(15)
    raise RuntimeError('AWS stack is still changing. Resume after checking its status; do not recreate it.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group()
    action.add_argument('--deploy', action='store_true')
    action.add_argument('--check-aws', action='store_true',
                        help='Check AWS credentials with STS without creating resources or a release.')
    action.add_argument('--status', action='store_true',
                        help='Read stack status and resource inventory without changing AWS resources.')
    parser.add_argument('--profile')
    parser.add_argument('--recover-failed-stack', action='store_true',
                        help='With --deploy, recreate an initial rolled-back stack only if no server or data disk was created.')
    parser.add_argument('--region', help='Override the local AWS region (default: ap-south-1).')
    parser.add_argument('--stack', default='knowledge-reader')
    parser.add_argument('--output', type=Path, default=ROOT / '.deployment')
    args = parser.parse_args()
    if args.recover_failed_stack and not args.deploy:
        parser.error('--recover-failed-stack requires --deploy')
    if not re.fullmatch(r'[a-z][a-z0-9-]{2,39}', args.stack):
        raise SystemExit('Use a lowercase stack name of 3–40 letters, digits or hyphens.')
    file_values = dotenv_values(ROOT / '.env', interpolate=False)
    if args.deploy or args.check_aws or args.status:
        try:
            session = aws_session(profile=args.profile, region=args.region, file_values=file_values)
            caller = session.client('sts').get_caller_identity()
        except ValueError as exc:
            raise SystemExit(str(exc)) from None
        except ClientError as exc:
            code = exc.response.get('Error', {}).get('Code', 'ClientError')
            raise SystemExit(f'AWS credential check failed ({code}). Check the selected credentials locally.') from None
        except BotoCoreError as exc:
            raise SystemExit(f'AWS credential check failed ({type(exc).__name__}). Check local AWS configuration and connectivity.') from None
        args.region = session.region_name
        if args.check_aws:
            print(f"AWS credentials verified; account ending {caller['Account'][-4:]}; region {args.region}.")
            print('No resources were created. Deployment permissions have not been checked.')
            return
        if args.status:
            report_stack(session.client('cloudformation'), args.stack, args.output)
            return
    bundle, checksum, template_path = package(args.output)
    print(f'Prepared release {checksum[:16]} and CloudFormation template in {args.output}', flush=True)
    if not args.deploy:
        print('No AWS resources were created. Verify credentials with --check-aws, then add --deploy.')
        return
    print(f"Deploying stack {args.stack} in {args.region}; account ending {caller['Account'][-4:]}", flush=True)
    values = provider_configuration(file_values)
    if not all(values.get(k) for k in ['OPENAI_API_KEY', 'SUPERMEMORY_API_KEY']):
        raise SystemExit('Configure both provider keys locally before provisioning.')
    try:
        auth_settings = auth_configuration(values)
    except ValueError as exc:
        raise SystemExit(str(exc)) from None
    cloudformation = session.client('cloudformation')
    cloudformation.validate_template(TemplateBody=template_path.read_text())
    try:
        existing = cloudformation.describe_stacks(StackName=args.stack)['Stacks'][0]
    except ClientError as exc:
        if exc.response['Error']['Code'] != 'ValidationError' or 'does not exist' not in exc.response['Error']['Message']:
            raise
        existing = None
    if existing and not any(t['Key'] == 'Project' and t['Value'] == 'KnowledgeReader' for t in existing.get('Tags', [])):
        raise SystemExit('That stack name is already used by another application. Choose a different --stack.')
    if existing and args.recover_failed_stack:
        recover_failed_stack(cloudformation, existing, args.output)
        existing = None
    if existing:
        # Infrastructure changes must be reviewed separately; application releases are safe to rerun.
        old = cloudformation.get_template(StackName=args.stack)['TemplateBody']
        if isinstance(old, str):
            old = json.loads(old)
        if old != template():
            raise SystemExit('The existing infrastructure differs. Review a CloudFormation change set before updating it.')
    else:
        prefix_list = cloudfront_prefix_list(session.client('ec2'))
        cloudformation.create_stack(StackName=args.stack, TemplateBody=template_path.read_text(),
            Capabilities=['CAPABILITY_NAMED_IAM'], EnableTerminationProtection=True,
            Parameters=[{'ParameterKey': 'CloudFrontPrefixListId', 'ParameterValue': prefix_list}],
            Tags=[{'Key': 'Project', 'Value': 'KnowledgeReader'}])
    outputs = wait_stack(cloudformation, args.stack)
    secrets = session.client('secretsmanager')
    settings = json.loads(secrets.get_secret_value(SecretId=outputs['SettingsSecretArn'])['SecretString'])
    settings.update({key: values[key] for key in ['OPENAI_API_KEY', 'SUPERMEMORY_API_KEY']})
    settings.update({'OPENAI_CHAT_MODEL': values.get('OPENAI_CHAT_MODEL', DEFAULT_OPENAI_MODEL),
        'PUBLIC_BASE_URL': outputs['URL'], 'COGNITO_POOL_ID': outputs['UserPoolId'],
        'COGNITO_CLIENT_ID': outputs['UserClientId'], 'COGNITO_DOMAIN': outputs['CognitoDomain'],
        'MAX_CONCURRENT_ANSWERS': '2', 'QUESTIONS_PER_USER_DAY': '20', 'QUESTIONS_PER_DAY': '200'})
    for key in ('GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'FRONTEND_ORIGIN', 'FRONTEND_PROXY_SECRET'):
        settings.pop(key, None)
    settings.update(auth_settings)
    secrets.put_secret_value(SecretId=outputs['SettingsSecretArn'], SecretString=json.dumps(settings))
    bucket = outputs['StorageBucket']
    key = f'releases/{checksum}.tar.gz'
    session.client('s3').upload_file(str(bundle), bucket, key, ExtraArgs={'ServerSideEncryption': 'AES256'})
    # Allow time for the EC2 instance to register with Systems Manager.
    ssm = session.client('ssm')
    for attempt in range(60):
        registered = ssm.describe_instance_information(Filters=[{'Key': 'InstanceIds', 'Values': [outputs['InstanceId']]}])
        if registered['InstanceInformationList'] and registered['InstanceInformationList'][0]['PingStatus'] == 'Online':
            break
        time.sleep(10)
    else:
        raise RuntimeError('The app instance is not online in Systems Manager. Resources were retained for diagnosis.')
    release = '/opt/knowledge-reader/releases/' + checksum[:16]
    archive = '/opt/knowledge-reader/release.tar.gz'
    commands = ['set -eu', 'mkdir -p ' + shlex.quote(release),
        shlex.join(['aws', 's3', 'cp', f's3://{bucket}/{key}', archive, '--region', args.region]),
        'printf ' + shlex.quote('%s  %s\n') + ' ' + shlex.quote(checksum) + ' ' + shlex.quote(archive) + ' | sha256sum -c -',
        shlex.join(['tar', '-xzf', archive, '-C', release]),
        shlex.join(['bash', release + '/deployment/bootstrap.sh', release, outputs['DataVolumeId'],
                    outputs['SettingsSecretArn'], args.region, bucket, outputs['LogGroup']])]
    command_id = ssm.send_command(InstanceIds=[outputs['InstanceId']], DocumentName='AWS-RunShellScript',
        Parameters={'commands': ['\n'.join(commands)], 'executionTimeout': ['1800']},
        Comment='Install tested Knowledge Reader release')['Command']['CommandId']
    (args.output / 'aws-resources.json').write_text(json.dumps({**outputs, 'region': args.region, 'stack': args.stack,
                                                              'release': checksum, 'ssm_command': command_id}, indent=2) + '\n')
    print('Installing the application through Systems Manager…', flush=True)
    for attempt in range(180):
        try:
            result = ssm.get_command_invocation(CommandId=command_id, InstanceId=outputs['InstanceId'])
        except ssm.exceptions.InvocationDoesNotExist:
            time.sleep(10)
            continue
        if result['Status'] == 'Success':
            print('Deployment installed: ' + outputs['URL'], flush=True)
            access_check = 'browser-session isolation' if auth_settings['PUBLIC_AUTH_MODE'] == 'guest' else 'sign-in and account isolation'
            print(f'Verify {access_check}, live questions and restart persistence before announcing the launch.')
            return
        if result['Status'] not in {'Pending', 'InProgress', 'Delayed'}:
            raise RuntimeError('Application installation failed. Check SSM command ' + command_id + ' and the service logs.')
        time.sleep(10)
    raise RuntimeError('Installation is still running. Check SSM command ' + command_id + ' before retrying.')


def run_cli():
    try:
        main()
    except ClientError as exc:
        code = exc.response.get('Error', {}).get('Code', 'ClientError')
        if code in {'AccessDenied', 'AccessDeniedException', 'UnauthorizedOperation'}:
            raise SystemExit(f'AWS denied {exc.operation_name} ({code}). '
                             'Check that the deployment identity has KnowledgeReaderDeploy '
                             'attached and that account policies permit this action. '
                             'Any resources already created have been left in place.') from None
        raise


if __name__ == '__main__':
    run_cli()
