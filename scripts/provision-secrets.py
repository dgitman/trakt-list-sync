"""Upload secrets from 1Password references; never persist or print secret values."""
import json, os, subprocess
names = ['ADMIN_KEY', 'ENCRYPTION_KEY', 'TRAKT_CLIENT_ID', 'TRAKT_CLIENT_SECRET']
secrets = {}
for name in names:
    ref = os.environ.get(name + '_REF', '')
    if not ref.startswith('op://'):
        raise SystemExit('Missing 1Password reference: ' + name + '_REF')
    result = subprocess.run(['op', 'read', ref], capture_output=True, text=True)
    if result.returncode:
        raise SystemExit('Could not read ' + name + ' from 1Password')
    secrets[name] = result.stdout.strip()
result = subprocess.run(['npx', 'wrangler', 'secret', 'bulk'], input=json.dumps(secrets), text=True, capture_output=True)
# Print only the result, never raw provider errors that might reflect inputs.
print('Cloudflare secrets uploaded' if result.returncode == 0 else 'Cloudflare secret upload failed')
raise SystemExit(result.returncode)
