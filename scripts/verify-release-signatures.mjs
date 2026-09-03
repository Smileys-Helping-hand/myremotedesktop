/**
 * Verifies release artifacts against the updater's public key.
 *
 * The updater refuses any package whose minisign signature does not match the
 * key compiled into the app. That check happens on the user's machine after the
 * download, so a mismatch does not show up in CI, in the release page, or
 * anywhere else — the update simply never installs. This performs the same
 * verification here.
 *
 * Usage: node scripts/verify-release-signatures.mjs <dir-with-artifacts>
 */
import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] ?? '.';

// The key the shipped app trusts.
const conf = JSON.parse(
  readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8')
);
const pubKeyFile = Buffer.from(conf.plugins.updater.pubkey, 'base64').toString('utf8');

/**
 * Second line of a minisign key/signature file is the payload.
 *
 * Tauri writes both the pubkey in tauri.conf.json and each `.sig` as base64 of
 * the *whole* minisign file, so the outer layer is peeled off before the lines
 * are read.
 */
function payloadLine(text, index = 1) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines[index] === undefined) {
    throw new Error(`expected at least ${index + 1} lines, got ${lines.length}`);
  }
  return Buffer.from(lines[index], 'base64');
}

/** Reads a `.sig`, which is base64 wrapping the minisign signature file. */
function readSignatureFile(file) {
  return Buffer.from(readFileSync(file, 'utf8').trim(), 'base64').toString('utf8');
}

const pub = payloadLine(pubKeyFile);
const pubAlg = pub.subarray(0, 2).toString('ascii');
const pubKeyId = pub.subarray(2, 10);
const pubKeyBytes = pub.subarray(10, 42);

// Node needs an SPKI-wrapped key; this is the fixed Ed25519 prefix.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const publicKey = createPublicKey({
  key: Buffer.concat([ED25519_SPKI_PREFIX, pubKeyBytes]),
  format: 'der',
  type: 'spki',
});

console.log(`\nVerifying against key ${pubKeyId.toString('hex').toUpperCase()} (alg ${pubAlg})\n`);

let failures = 0;
const sigFiles = readdirSync(dir).filter((f) => f.endsWith('.sig'));

if (sigFiles.length === 0) {
  console.error('  no .sig files found — nothing to verify');
  process.exit(1);
}

for (const sigName of sigFiles) {
  const artifactName = sigName.replace(/\.sig$/, '');
  const artifactPath = path.join(dir, artifactName);

  let artifact;
  try {
    artifact = readFileSync(artifactPath);
  } catch {
    console.error(`  ✗ ${artifactName} — signature present but the artifact is missing`);
    failures++;
    continue;
  }

  const sig = payloadLine(readSignatureFile(path.join(dir, sigName)));
  const sigAlg = sig.subarray(0, 2).toString('ascii');
  const sigKeyId = sig.subarray(2, 10);
  const signature = sig.subarray(10, 74);

  if (!sigKeyId.equals(pubKeyId)) {
    console.error(
      `  ✗ ${artifactName} — signed by key ${sigKeyId.toString('hex').toUpperCase()}, ` +
        `but the app trusts ${pubKeyId.toString('hex').toUpperCase()}`
    );
    failures++;
    continue;
  }

  // "ED" signs a BLAKE2b-512 hash of the file; "Ed" signs the file itself.
  const message =
    sigAlg === 'ED' ? createHash('blake2b512').update(artifact).digest() : artifact;

  if (edVerify(null, message, publicKey, signature)) {
    console.log(
      `  ✓ ${artifactName} — signature valid (${sigAlg === 'ED' ? 'prehashed' : 'legacy'})`
    );
  } else {
    console.error(`  ✗ ${artifactName} — SIGNATURE DOES NOT VERIFY; the updater would refuse it`);
    failures++;
  }
}

console.log(
  failures === 0
    ? '\nEvery artifact verifies against the key the app ships with.\n'
    : `\n${failures} artifact(s) FAILED verification.\n`
);
process.exit(failures === 0 ? 0 : 1);
