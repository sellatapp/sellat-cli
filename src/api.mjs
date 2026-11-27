/**
 * Minimal client for the SELLAT API v2 (https://sellat.app/developers).
 *
 * Hash-only by design — the proof endpoints never accept file contents:
 *
 *   POST   /api/v2/proofs                      { hash, name?, metadata?, qualified?, group? } → 201
 *   GET    /api/v2/proofs/:id                   state, anchors, Bitcoin, seal, URLs
 *   GET    /api/v2/proofs?limit&cursor&group    the account's proofs, or one group's
 *   GET    /api/v2/groups?limit&cursor&name     the account's groups (the dashboard's evidence files)
 *   GET    /api/v2/groups/:id                   one group: name, proofs, link
 *   POST   /api/v2/groups/:id/link              switch the group's public link on
 *   DELETE /api/v2/groups/:id/link              pause it
 *   POST   /api/v2/proofs/:id/qualified         the qualified eIDAS seal
 *   GET    /api/v2/proofs/:id/qualified.tsr     the RFC 3161 token
 *   GET    /api/v2/proofs/:id/certificate.pdf   the certificate
 *   GET    /api/v2/proofs/:id/evidence.zip      the evidence package
 *   PUT    /api/v2/proofs/:id/original          custody of the original (the one call that sends bytes, on purpose)
 *   GET    /api/v2/proofs/:id/original          download it
 *   DELETE /api/v2/proofs/:id/original          end custody; the proof is untouched
 *   GET    /api/v2/account                      seals, custody, today's budget
 *
 * Proofs are batched in a Merkle tree and anchored on Polygon within
 * minutes; every batch root is also attested on Bitcoin through
 * OpenTimestamps. Full reference: docs/api.md in the sellat-app repository.
 */

export class SellatApiError extends Error {
  constructor(message, { status, code, retryAfterSeconds, details } = {}) {
    super(message);
    this.name = 'SellatApiError';
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
    this.details = details;
  }
}

export function createClient({
  token,
  baseUrl = 'https://sellat.app',
  fetchImpl = fetch,
} = {}) {
  if (!token) {
    throw new SellatApiError(
      'Missing API token. Set SELLAT_API_TOKEN or pass --token. Create one in your dashboard: https://sellat.app/dashboard#api-keys'
    );
  }

  const base = baseUrl.replace(/\/+$/, '');

  async function request(method, path, { body, rawBody, contentType, headers = {}, binary = false } = {}) {
    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(rawBody !== undefined ? { 'Content-Type': contentType ?? 'application/octet-stream' } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(rawBody !== undefined ? { body: rawBody } : {}),
    });

    if (response.ok && binary) {
      return {
        bytes: Buffer.from(await response.arrayBuffer()),
        contentType: response.headers.get('content-type'),
        fileName: fileNameFrom(response.headers.get('content-disposition')),
        status: response.status,
      };
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      /* non-JSON error body — handled below via status */
    }

    // v2 errors are { error: { code, message, … } }; v1 used { success: false, error: "…" }.
    const error = payload?.error;
    const message = typeof error === 'object' && error ? error.message : typeof error === 'string' ? error : null;
    const code = typeof error === 'object' && error ? error.code : undefined;

    if (response.status === 401) {
      throw new SellatApiError('Invalid or revoked API token.', { status: 401, code: 'unauthorized' });
    }
    if (response.status === 402) {
      const remaining = error?.seals_remaining ?? 0;
      throw new SellatApiError(
        `${message ?? 'No qualified seals left.'} (seals remaining: ${remaining}) → ${error?.buy_url ?? 'https://sellat.app/precios'}`,
        { status: 402, code: 'payment_required', details: error }
      );
    }
    if (response.status === 429) {
      const retryAfterSeconds = Number(response.headers.get('retry-after') ?? 60);
      throw new SellatApiError(`${message ?? 'Rate limited'} — retry in ${retryAfterSeconds}s.`, {
        status: 429,
        code: code ?? 'rate_limited',
        retryAfterSeconds,
        details: error,
      });
    }
    if (!response.ok || payload?.success === false) {
      throw new SellatApiError(message ?? `API answered HTTP ${response.status}.`, {
        status: response.status,
        code,
        details: typeof error === 'object' ? error : undefined,
      });
    }

    return payload;
  }

  const proofPath = (id) => `/api/v2/proofs/${encodeURIComponent(id)}`;
  const groupPath = (id) => `/api/v2/groups/${encodeURIComponent(id)}`;

  return {
    /**
     * Create a proof from a SHA-256. `qualified: true` also issues the qualified
     * seal in the same call. `group` files it under one of the account's groups
     * by name, created the first time: one group for the steps of one job.
     * Returns the proof object (`id`, `state`, `group`, `urls`…).
     */
    create({ hash, name, metadata, size, mimeType, qualified, group, idempotencyKey }) {
      return request('POST', '/api/v2/proofs', {
        body: {
          hash,
          ...(name !== undefined ? { name } : {}),
          ...(metadata !== undefined ? { metadata } : {}),
          ...(size !== undefined ? { size } : {}),
          ...(mimeType !== undefined ? { mime_type: mimeType } : {}),
          ...(qualified ? { qualified: true } : {}),
          ...(group !== undefined ? { group } : {}),
        },
        headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {},
      });
    },

    /** The proof as it stands now: state, anchors, Bitcoin, seal, original, URLs. */
    get(id) {
      return request('GET', proofPath(id));
    },

    /** One page of the account's proofs, newest first. `group` (an id) keeps one group's. */
    list({ limit, cursor, group } = {}) {
      const params = new URLSearchParams();
      if (limit) params.set('limit', String(limit));
      if (cursor) params.set('cursor', String(cursor));
      if (group) params.set('group', String(group));
      const query = params.toString();
      return request('GET', `/api/v2/proofs${query ? `?${query}` : ''}`);
    },

    /** One page of the account's groups, newest first. `name` finds one group by its exact name. */
    groups({ limit, cursor, name, lang } = {}) {
      const params = new URLSearchParams();
      if (limit) params.set('limit', String(limit));
      if (cursor) params.set('cursor', String(cursor));
      if (name) params.set('name', String(name));
      if (lang) params.set('lang', String(lang));
      const query = params.toString();
      return request('GET', `/api/v2/groups${query ? `?${query}` : ''}`);
    },

    /** One group: its name, how many proofs it holds and its link. */
    group(id, { lang } = {}) {
      return request('GET', `${groupPath(id)}${lang ? `?lang=${encodeURIComponent(lang)}` : ''}`);
    },

    /**
     * Switch the group's public link on. Whoever holds the URL sees the group's
     * name and each proof's name, without an account. Nothing is public before this.
     */
    openLink(id, { lang } = {}) {
      return request('POST', `${groupPath(id)}/link${lang ? `?lang=${encodeURIComponent(lang)}` : ''}`);
    },

    /** Pause the link: the URL stops opening until it is switched on again. */
    closeLink(id, { lang } = {}) {
      return request('DELETE', `${groupPath(id)}/link${lang ? `?lang=${encodeURIComponent(lang)}` : ''}`);
    },

    /** The qualified eIDAS seal. Spends a seal from the account; 402 when there is none. */
    seal(id) {
      return request('POST', `${proofPath(id)}/qualified`);
    },

    /** The RFC 3161 token, DER. */
    tsr(id) {
      return request('GET', `${proofPath(id)}/qualified.tsr`, { binary: true });
    },

    certificate(id, { lang = 'en' } = {}) {
      return request('GET', `${proofPath(id)}/certificate.pdf?lang=${encodeURIComponent(lang)}`, { binary: true });
    },

    evidence(id, { lang = 'en' } = {}) {
      return request('GET', `${proofPath(id)}/evidence.zip?lang=${encodeURIComponent(lang)}`, { binary: true });
    },

    /** Deposit the original in custody. The only call that sends bytes — and only when you ask for it. */
    putOriginal(id, bytes, { contentType } = {}) {
      return request('PUT', `${proofPath(id)}/original`, { rawBody: bytes, contentType });
    },

    getOriginal(id) {
      return request('GET', `${proofPath(id)}/original`, { binary: true });
    },

    deleteOriginal(id) {
      return request('DELETE', `${proofPath(id)}/original`);
    },

    /** Plan, seals remaining, custody usage, today's proof budget. */
    account() {
      return request('GET', '/api/v2/account');
    },
  };
}

/** True once the batch is anchored: the proof is independently verifiable from here on. */
export function isAnchored(proof) {
  return proof?.state === 'anchored' || proof?.state === 'confirmed';
}

export function isFailed(proof) {
  return proof?.state === 'failed';
}

function fileNameFrom(disposition) {
  if (!disposition) return null;
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  if (utf8) {
    try {
      return decodeURIComponent(utf8[1]);
    } catch {
      /* fall through */
    }
  }
  const plain = /filename="([^"]+)"/i.exec(disposition);
  return plain ? plain[1] : null;
}
