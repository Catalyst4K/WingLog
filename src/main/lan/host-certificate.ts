/**
 * The sim PC's own TLS certificate for the twin link, and the pin a twin checks it by (winglog-backend's
 * docs/plans/security-audit-v2.md, step 22).
 *
 * Node has no way to make a certificate (`crypto.X509Certificate` only reads one), so this writes the one shape the link needs, around
 * `node:crypto`'s key and signature: X.509 v3, ECDSA P-256, signed with SHA-256, the subject and issuer both `CN=WingLog sim PC`, a random
 * serial, valid from 2000 to 9999, and no extensions and no names. No names, because the pin is the identity and the address changes. No
 * extensions, because BoringSSL (Electron's TLS) is stricter than OpenSSL about them. P-256, because Ed25519 fails Electron's TLS unless
 * both ends name it. The twin trusts the certificate by its pin alone (`ws-socket.ts`), so nothing here but the key affects security.
 */

import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'

/** The dates the certificate is valid between: RFC 5280's "no expiry", since nothing renews it and a twin's clock may be wrong. */
const NOT_BEFORE_UTC_TIME = '000101000000Z'
const NOT_AFTER_GENERALIZED_TIME = '99991231235959Z'

/** The common name in the subject and the issuer. */
const COMMON_NAME = 'WingLog sim PC'

/** The bytes of the object identifier `ecdsa-with-SHA256` (1.2.840.10045.4.3.2), without its tag and length. */
const OID_ECDSA_WITH_SHA256 = Buffer.from([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02])

/** The bytes of the object identifier `commonName` (2.5.4.3), without its tag and length. */
const OID_COMMON_NAME = Buffer.from([0x55, 0x04, 0x03])

/** DER tags used below. */
const TAG_INTEGER = 0x02
const TAG_BIT_STRING = 0x03
const TAG_OID = 0x06
const TAG_UTF8_STRING = 0x0c
const TAG_UTC_TIME = 0x17
const TAG_GENERALIZED_TIME = 0x18
const TAG_SEQUENCE = 0x30
const TAG_SET = 0x31
/** The context tag `[0]`, constructed: the certificate's version. */
const TAG_VERSION = 0xa0

/** The certificate's version field: 2 is v3. */
const VERSION_3 = 2

/** The serial number's length in bytes. */
const SERIAL_BYTES = 16

/** Characters in a base64 line of a PEM file. */
const PEM_LINE_CHARS = 64

/** A key and certificate for the host's TLS server. */
export interface HostCertificate {
  /** The private key, PKCS#8 PEM. It never leaves the host: not logged, not sent, not in the database. */
  keyPem: string
  /** The certificate, PEM. */
  certPem: string
  /** The certificate, DER: what the pin is taken over. */
  certDer: Buffer
}

/**
 * @param length A content length in bytes.
 * @returns Its DER length encoding.
 */
function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length])
  if (length < 0x100) return Buffer.from([0x81, length])
  return Buffer.from([0x82, length >> 8, length & 0xff])
}

/**
 * @param tag The DER tag.
 * @param content The value's bytes.
 * @returns The tag, length and value.
 */
function der(tag: number, ...content: Buffer[]): Buffer {
  const body = Buffer.concat(content)
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body])
}

/** @returns The name `CN=WingLog sim PC`, used as both subject and issuer. */
function commonNameSequence(): Buffer {
  const attribute = der(
    TAG_SEQUENCE,
    der(TAG_OID, OID_COMMON_NAME),
    der(TAG_UTF8_STRING, Buffer.from(COMMON_NAME, 'utf8'))
  )
  return der(TAG_SEQUENCE, der(TAG_SET, attribute))
}

/**
 * @param publicKeyDer The key's SubjectPublicKeyInfo, DER.
 * @param serial The serial number's bytes (the first between 0x40 and 0x7f: a positive number in DER's shortest form).
 * @returns The certificate's TBSCertificate: everything the signature covers.
 */
function toBeSigned(publicKeyDer: Buffer, serial: Buffer): Buffer {
  const signatureAlgorithm = der(TAG_SEQUENCE, der(TAG_OID, OID_ECDSA_WITH_SHA256))
  const validity = der(
    TAG_SEQUENCE,
    der(TAG_UTC_TIME, Buffer.from(NOT_BEFORE_UTC_TIME, 'ascii')),
    der(TAG_GENERALIZED_TIME, Buffer.from(NOT_AFTER_GENERALIZED_TIME, 'ascii'))
  )
  return der(
    TAG_SEQUENCE,
    der(TAG_VERSION, der(TAG_INTEGER, Buffer.from([VERSION_3]))),
    der(TAG_INTEGER, serial),
    signatureAlgorithm,
    commonNameSequence(),
    validity,
    commonNameSequence(),
    publicKeyDer
  )
}

/**
 * @param certificate A certificate, DER.
 * @returns It as PEM (what Node's TLS server takes).
 */
export function certificateToPem(certificate: Buffer): string {
  const lines = certificate.toString('base64').match(new RegExp(`.{1,${PEM_LINE_CHARS}}`, 'g')) ?? []
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`
}

/**
 * Makes a new key and a self-signed certificate for it. About a third of a millisecond.
 *
 * @returns The key and the certificate. Two calls never give the same key or serial.
 */
export function makeHostCertificate(): HostCertificate {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const serial = randomBytes(SERIAL_BYTES)
  // A positive serial: the top bit clear, and a non-zero first byte so DER's shortest form holds.
  serial[0] = ((serial[0] ?? 0) & 0x3f) | 0x40
  const tbs = toBeSigned(publicKey.export({ type: 'spki', format: 'der' }), serial)
  const signature = sign('sha256', tbs, privateKey)
  const signatureAlgorithm = der(TAG_SEQUENCE, der(TAG_OID, OID_ECDSA_WITH_SHA256))
  // The signature's bit string starts with a byte for the number of unused bits: none.
  const certDer = der(TAG_SEQUENCE, tbs, signatureAlgorithm, der(TAG_BIT_STRING, Buffer.from([0]), signature))
  return {
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    certPem: certificateToPem(certDer),
    certDer
  }
}

/**
 * @param certificateDer A certificate, DER (a `getPeerCertificate().raw`).
 * @returns Its pin: SHA-256 over the DER, base64url, 43 characters. It is public: it is in the status Settings reads and in the twin's stored link.
 */
export function certificatePin(certificateDer: Buffer): string {
  return createHash('sha256').update(certificateDer).digest('base64url')
}
