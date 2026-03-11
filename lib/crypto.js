import crypto from 'node:crypto';

function getEncryptionKey() {
  const raw = process.env.STORE_TOKEN_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error('STORE_TOKEN_ENCRYPTION_KEY not configured');
  }

  if (/^[a-f0-9]{64}$/i.test(raw)) {
    return Buffer.from(raw, 'hex');
  }

  const base64 = Buffer.from(raw, 'base64');
  if (base64.length === 32) return base64;

  throw new Error('STORE_TOKEN_ENCRYPTION_KEY must be 32 bytes as hex or base64');
}

export function encryptSecret(value) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

export function decryptSecret(payload) {
  const key = getEncryptionKey();
  const input = Buffer.from(payload, 'base64');
  const iv = input.subarray(0, 12);
  const tag = input.subarray(12, 28);
  const encrypted = input.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}
