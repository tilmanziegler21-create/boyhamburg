const fs = require('fs');
const path = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_PATH || 'service-account.json';
try {
  const raw = fs.readFileSync(path, 'utf-8');
  const j = JSON.parse(raw);
  const email = String(j.client_email || '');
  const key = String(j.private_key || '');
  const keyEsc = key.replace(/\n/g, '\\n');
  const lines = [
    `GOOGLE_SERVICE_ACCOUNT_EMAIL=${email}`,
    `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY=${keyEsc}`
  ];
  console.log(lines.join('\n'));
  fs.writeFileSync('.env.sa', lines.join('\n'));
} catch (e) {
  console.error('Failed to read service account JSON:', String(e));
  process.exit(1);
}

