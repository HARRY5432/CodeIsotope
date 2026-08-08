import { JS, type Detector } from '../detector-types.ts';

/**
 * Security-sensitive reinventions. These are the ones where a hand-rolled version
 * is not merely unidiomatic -- it is a vulnerability. Notes are written to be quoted
 * straight into a report.
 */
export const SECURITY_DETECTORS: Detector[] = [
  {
    id: 'insecure-random-id',
    capability: 'generating unique / random IDs',
    ext: JS,
    signals: [
      { name: 'math-random-base36', re: /Math\.random\(\)\s*\.toString\(\s*36\s*\)/ },
      { name: 'id-vocab', re: /\b(uuid|guid|generateId|randomId|makeId|token|sessionId|apiKey)\b/i },
      { name: 'math-random-slice', re: /Math\.random\(\)[\s\S]{0,60}\.(slice|substr|substring)\(/ },
    ],
    minSignals: 2,
    decisive: ['math-random-base36'],
    searchTerms: ['secure unique id generator node', 'nanoid vs uuid'],
    knownSolutions: ['crypto.randomUUID (built-in)', 'nanoid', 'uuid', 'ulid'],
    suppressIfDeps: ['nanoid', 'uuid', 'ulid', 'cuid2', '@paralleldrive/cuid2', 'uuidv7'],
    note: 'SECURITY: Math.random() is not cryptographically secure and is predictable from a few outputs. If any of these IDs are session tokens, API keys, or password-reset links, this is an exploitable vulnerability -- use crypto.randomUUID() or crypto.getRandomValues().',
    baseConfidence: 'high',
  },
  {
    id: 'password-hashing',
    capability: 'password hashing',
    ext: JS,
    signals: [
      { name: 'fast-hash', re: /createHash\(\s*['"`](md5|sha1|sha256|sha512)['"`]\s*\)/ },
      { name: 'password-vocab', re: /\b(password|passwd|pwd|passphrase)\b/i },
      { name: 'digest', re: /\.digest\(/ },
    ],
    minSignals: 3,
    required: ['password-vocab', 'fast-hash'],
    searchTerms: ['argon2 password hashing node', 'bcrypt vs argon2'],
    knownSolutions: ['@node-rs/argon2', 'argon2', 'bcrypt', 'node:crypto scrypt (built-in)'],
    suppressIfDeps: ['argon2', '@node-rs/argon2', 'bcrypt', 'bcryptjs', '@node-rs/bcrypt', 'scrypt-kdf', '@oslojs/crypto'],
    note: 'SECURITY: general-purpose hashes are far too fast for passwords -- a GPU tries billions of guesses per second against them. Use a memory-hard KDF (argon2id, scrypt, bcrypt) with a per-user salt.',
    baseConfidence: 'high',
  },
  {
    id: 'manual-jwt',
    capability: 'signing / verifying JWTs',
    ext: JS,
    signals: [
      { name: 'base64url', re: /base64url|toString\(\s*['"`]base64['"`]\s*\)/ },
      { name: 'hmac', re: /createHmac\(/ },
      { name: 'jwt-vocab', re: /\b(jwt|jws|accessToken|idToken|bearer)\b/i },
      { name: 'dot-segments', re: /\.join\(\s*['"`]\.['"`]\s*\)|\.split\(\s*['"`]\.['"`]\s*\)/ },
    ],
    minSignals: 3,
    required: ['jwt-vocab'],
    searchTerms: ['jose jwt verify node', 'jsonwebtoken alternative'],
    knownSolutions: ['jose', 'jsonwebtoken', 'fast-jwt'],
    suppressIfDeps: ['jose', 'jsonwebtoken', 'fast-jwt', 'jwt-decode', '@panva/jose'],
    note: 'SECURITY: hand-rolled JWT verification is a classic auth-bypass source -- algorithm confusion, accepting "alg":"none", skipping exp/aud/iss checks, and non-constant-time signature comparison.',
    baseConfidence: 'high',
  },
  {
    id: 'hand-rolled-validation',
    capability: 'runtime schema / input validation',
    ext: JS,
    signals: [
      { name: 'typeof-guard', re: /if\s*\(\s*typeof\s+[\w.[\]'"]+\s*!==\s*['"](string|number|boolean|object)['"]/ },
      { name: 'throw-required', re: /throw new (Error|TypeError)\(\s*[`'"][^`'"]*(required|must be|invalid|expected)/i },
      { name: 'array-guard', re: /Array\.isArray\(/ },
      { name: 'validate-fn', re: /\bfunction\s+validate\w*|\bconst\s+validate\w*\s*=/ },
    ],
    minSignals: 3,
    required: ['validate-fn'],
    searchTerms: ['typescript runtime validation library', 'zod vs valibot'],
    knownSolutions: ['zod', 'valibot', 'arktype', 'ajv'],
    suppressIfDeps: ['zod', 'valibot', 'arktype', 'ajv', 'yup', 'joi', 'superstruct', '@sinclair/typebox', 'class-validator'],
    note: 'Hand-rolled guards drift out of sync with your TypeScript types and produce unhelpful errors. A schema library derives the type and the validator from one declaration.',
    baseConfidence: 'low',
  },
];
