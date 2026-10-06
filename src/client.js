/**
 * A small SpicyAPI client for the browser.
 *
 * It covers what the extension needs: the model catalogue, the balance, quotes, task creation,
 * polling and result downloads. Requests go straight from the browser to the API by default; when
 * that is not possible (an older API without CORS, a network that blocks it) they can be routed
 * through SillyTavern's own CORS proxy at `/proxy/<url>`, which has to be enabled in config.yaml.
 *
 * This module has no SillyTavern imports so it can be tested under Node.
 */

export const DEFAULT_BASE_URL = 'https://api.spicyapi.ai';

export const TRANSPORTS = Object.freeze({
    AUTO: 'auto',
    DIRECT: 'direct',
    PROXY: 'proxy',
});

const REQUEST_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
const MAX_RETRIES = 3;
const RETRYABLE_HTTP = new Set([408, 429, 500, 502, 503, 504]);
const RETRYABLE_CODES = new Set([429, 500, 50301]);
// 50302 rides on a 503, but resending under the same Idempotency-Key only replays the recorded
// failure, so it is never retried.
const NON_RETRYABLE_CODES = new Set([50302]);

export const TERMINAL_STATES = new Set(['succeeded', 'failed', 'canceled', 'expired']);
const ACTIVE_STATES = new Set(['queued', 'running']);

// What to do about a business code. Branch on the code, never on the message: the message follows
// the account's API error language, the code never changes.
const RECOVERY_BY_CODE = {
    40004: 'No deployment serves this combination of settings. Change the setting named above, or pick another model.',
    40310: 'Your SpicyAPI account has not verified its email address yet. Open the verification link sent at sign-up, then try again.',
    40901: 'The price changed before the task was created. Try again to accept the new price.',
    50301: 'This model has no usable deployment right now. Try again later or pick another model.',
    50302: 'The generation failed upstream and was refunded. Try again.',
};

export class SpicyApiError extends Error {
    /**
     * @param {string} message
     * @param {{status?: number, code?: number|null, requestId?: string, kind?: string}} [details]
     */
    constructor(message, { status = 0, code = null, requestId = '', kind = 'api' } = {}) {
        super(message);
        this.name = 'SpicyApiError';
        this.status = status;
        this.code = code;
        this.requestId = requestId;
        /** api | network | proxy-disabled | proxy-auth | timeout | aborted */
        this.kind = kind;
    }

    get recovery() {
        return RECOVERY_BY_CODE[this.code ?? 0] || '';
    }

    /** The API's own message, followed by what to do about it and the request id for support. */
    describe() {
        return [this.message, this.recovery, this.requestId ? `(request_id ${this.requestId})` : '']
            .filter(Boolean)
            .join(' ');
    }
}

export class SpicyTaskError extends Error {
    /** @param {Record<string, any>} task */
    constructor(task) {
        const code = task?.errorCode || task?.state || 'failed';
        const message = task?.errorMessage || `The task ended as ${task?.state}.`;
        super(`${code}: ${message}`);
        this.name = 'SpicyTaskError';
        this.task = task;
        this.errorCode = code;
    }

    describe() {
        const hint = this.errorCode === 'content_rejected'
            ? ' The model declined this request. Unless the model page says refusals are billed, nothing was charged. A model marked Uncensored may accept it.'
            : '';
        return `${this.message}${hint} (task ${this.task?.taskId})`;
    }
}

/**
 * The URL that sends `target` through SillyTavern's CORS proxy.
 *
 * The target must be URL-encoded as a whole: the proxy reads it from an Express path parameter,
 * which drops the query string of an unencoded URL (and with it `taskId`, `modality` and the
 * signature of a download link).
 * @param {string} origin SillyTavern origin, e.g. http://127.0.0.1:8000
 * @param {string} target Absolute URL to reach
 */
export function proxyUrl(origin, target) {
    return `${String(origin).replace(/\/+$/, '')}/proxy/${encodeURIComponent(target)}`;
}

/** Normalises a base URL: no trailing slash, no `/v1` or `/api/v1` suffix. */
export function normalizeBaseUrl(value) {
    let url = String(value || '').trim() || DEFAULT_BASE_URL;
    url = url.replace(/\/+$/, '');
    url = url.replace(/\/(api\/)?v1$/, '');
    return url;
}

/** $0.432, $0.0246, $1.08: enough digits to be exact, no trailing zeros beyond the cents. */
export function formatUsd(value) {
    const text = String(value ?? '').trim();
    if (!/^-?\d+(\.\d+)?$/.test(text)) {
        return text ? `$${text}` : '';
    }
    let [whole, fraction = ''] = text.replace(/^-/, '').split('.');
    fraction = fraction.replace(/0+$/, '');
    if (fraction.length < 2) {
        fraction = fraction.padEnd(2, '0');
    }
    whole = String(Number(whole));
    return `${text.startsWith('-') ? '-' : ''}$${whole}.${fraction}`;
}

/** Parses a USD decimal string to a number; null when it is not one. */
export function usdToNumber(value) {
    const number = Number.parseFloat(String(value ?? ''));
    return Number.isFinite(number) ? number : null;
}

function retryDelayMs(attempt, retryAfterSeconds, random = Math.random) {
    const exponential = Math.min(500 * (2 ** attempt), 8000) * (0.8 + random() * 0.4);
    return Math.max(exponential, (retryAfterSeconds || 0) * 1000);
}

function parseRetryAfter(value) {
    if (!value) return null;
    const seconds = Number.parseFloat(value);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

/** A signal that aborts on the caller's signal or after `ms`, whichever comes first. */
function timeoutSignal(ms, signal) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), ms);
    const onAbort = () => controller.abort(signal.reason);
    if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
    }
    return {
        signal: controller.signal,
        done() {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
        },
    };
}

function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(abortedError(signal));
            return;
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(abortedError(signal));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

function abortedError(signal) {
    const reason = signal?.reason;
    if (reason instanceof SpicyApiError) return reason;
    return new SpicyApiError(typeof reason === 'string' ? reason : 'Stopped.', { kind: 'aborted' });
}

/** A fresh idempotency key for one submission. */
export function newIdempotencyKey() {
    if (globalThis.crypto?.randomUUID) {
        return globalThis.crypto.randomUUID();
    }
    return `st-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export class SpicyClient {
    /**
     * @param {object} options
     * @param {string} options.apiKey
     * @param {string} [options.baseUrl]
     * @param {string} [options.transport] auto | direct | proxy
     * @param {string} [options.origin] SillyTavern origin for the proxy (defaults to location.origin)
     * @param {() => Record<string, string>} [options.stHeaders] SillyTavern request headers (CSRF token)
     * @param {typeof fetch} [options.fetch]
     */
    constructor({ apiKey, baseUrl, transport = TRANSPORTS.AUTO, origin, stHeaders, fetch: fetchImpl } = {}) {
        this.apiKey = String(apiKey || '').trim();
        this.baseUrl = normalizeBaseUrl(baseUrl);
        this.transport = Object.values(TRANSPORTS).includes(transport) ? transport : TRANSPORTS.AUTO;
        this.origin = origin ?? globalThis.location?.origin ?? '';
        this.stHeaders = stHeaders || (() => ({}));
        this.fetch = fetchImpl || globalThis.fetch.bind(globalThis);
        /**
         * Hosts the browser could not reach directly in auto mode. Later requests to them go
         * straight to the proxy instead of failing the direct route again. Kept per host because
         * the API and the file storage can differ (one may allow cross-origin requests while the
         * other does not).
         */
        this.proxiedHosts = new Set();
        /** How the last successful request travelled: direct or proxy. */
        this.lastRoute = '';
    }

    // -- Transport ---------------------------------------------------------

    async #viaProxy(target, init) {
        const headers = { ...this.stHeaders(), ...(init.headers || {}) };
        // SillyTavern's own Content-Type header must not override ours on a GET.
        if (!init.body) delete headers['Content-Type'];
        let response;
        try {
            response = await this.fetch(proxyUrl(this.origin, target), { ...init, headers });
        } catch (error) {
            if (init.signal?.aborted) throw abortedError(init.signal);
            throw new SpicyApiError(`Could not reach SillyTavern's proxy: ${error?.message || error}`, { kind: 'network' });
        }
        if (response.status === 404) {
            const text = await response.clone().text().catch(() => '');
            if (/CORS proxy is disabled/i.test(text)) {
                throw new SpicyApiError(
                    'SillyTavern\'s CORS proxy is turned off. Set enableCorsProxy: true in config.yaml (or start SillyTavern with --corsProxy) and restart it, or switch the SpicyAPI connection to Direct.',
                    { status: 404, kind: 'proxy-disabled' },
                );
            }
        }
        if (response.status === 401 && /basic/i.test(response.headers.get('WWW-Authenticate') || '')) {
            throw new SpicyApiError(
                'SillyTavern\'s basic authentication rejects requests that carry an API key, so its CORS proxy cannot be used here. Switch the SpicyAPI connection to Direct.',
                { status: 401, kind: 'proxy-auth' },
            );
        }
        this.lastRoute = 'proxy';
        return response;
    }

    /**
     * Sends one request by the configured route. In auto mode a request that the browser could not
     * send at all (a TypeError from fetch: network failure or a CORS rejection) is sent again
     * through the proxy; that is safe for writes because every billable call carries an
     * Idempotency-Key.
     */
    async send(target, init) {
        const host = (() => {
            try { return new URL(target).host; } catch { return String(target); }
        })();
        if (this.transport === TRANSPORTS.PROXY || (this.transport === TRANSPORTS.AUTO && this.proxiedHosts.has(host))) {
            return this.#viaProxy(target, init);
        }
        try {
            const response = await this.fetch(target, init);
            this.lastRoute = 'direct';
            return response;
        } catch (error) {
            if (init.signal?.aborted) throw abortedError(init.signal);
            if (this.transport === TRANSPORTS.AUTO) {
                try {
                    const response = await this.#viaProxy(target, init);
                    this.proxiedHosts.add(host);
                    return response;
                } catch (proxyError) {
                    if (proxyError instanceof SpicyApiError && proxyError.kind !== 'network') {
                        throw new SpicyApiError(
                            `The browser could not reach ${host} (network error or CORS), and the fallback failed too: ${proxyError.message}`,
                            { kind: proxyError.kind, status: proxyError.status },
                        );
                    }
                    throw new SpicyApiError(
                        `Could not reach ${host} from the browser or through SillyTavern's proxy. Check your internet connection.`,
                        { kind: 'network' },
                    );
                }
            }
            throw new SpicyApiError(
                `The browser could not reach ${host} (network error or CORS). If your SillyTavern has its CORS proxy enabled, set the SpicyAPI connection to Auto or SillyTavern proxy.`,
                { kind: 'network' },
            );
        }
    }

    #authHeaders() {
        if (!this.apiKey) {
            throw new SpicyApiError('No SpicyAPI key is set. Paste one in Extensions > SpicyAPI (create it at https://spicyapi.ai/console/keys).', { kind: 'config' });
        }
        return { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' };
    }

    // -- Envelope requests -------------------------------------------------

    /**
     * Calls an endpoint that answers with the `{code, msg, data, request_id}` envelope.
     * @param {string} method
     * @param {string} path Path under the base URL, starting with /
     * @param {{body?: any, headers?: Record<string,string>, retry?: boolean, timeoutMs?: number, signal?: AbortSignal}} [options]
     */
    async request(method, path, { body, headers, retry = true, timeoutMs = REQUEST_TIMEOUT_MS, signal } = {}) {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const requestHeaders = { ...this.#authHeaders(), ...(headers || {}) };
        if (payload !== undefined) requestHeaders['Content-Type'] = 'application/json';

        for (let attempt = 0; ; attempt++) {
            const timer = timeoutSignal(timeoutMs, signal);
            let response;
            let raw;
            try {
                response = await this.send(`${this.baseUrl}${path}`, {
                    method,
                    headers: requestHeaders,
                    body: payload,
                    signal: timer.signal,
                });
                raw = await response.text();
            } catch (error) {
                timer.done();
                if (signal?.aborted) throw abortedError(signal);
                if (timer.signal.aborted) {
                    if (retry && attempt < MAX_RETRIES) {
                        await sleep(retryDelayMs(attempt, null), signal);
                        continue;
                    }
                    throw new SpicyApiError(`SpicyAPI did not answer within ${Math.round(timeoutMs / 1000)} seconds.`, { kind: 'timeout' });
                }
                throw error;
            }
            timer.done();

            const status = response.status;
            const retryAfter = parseRetryAfter(response.headers.get('Retry-After'));
            let envelope;
            try {
                envelope = JSON.parse(raw);
            } catch {
                if (retry && attempt < MAX_RETRIES && RETRYABLE_HTTP.has(status)) {
                    await sleep(retryDelayMs(attempt, retryAfter), signal);
                    continue;
                }
                const snippet = String(raw || '').replace(/\s+/g, ' ').slice(0, 160);
                throw new SpicyApiError(
                    `SpicyAPI answered HTTP ${status} with a body that is not JSON${snippet ? `: ${snippet}` : ''}`,
                    { status },
                );
            }
            envelope = envelope && typeof envelope === 'object' ? envelope : {};
            const code = typeof envelope.code === 'number' ? envelope.code : null;
            const failed = status < 200 || status >= 300 || code !== 200;
            const resendHelps = !NON_RETRYABLE_CODES.has(code) && (RETRYABLE_HTTP.has(status) || RETRYABLE_CODES.has(code));
            if (failed && retry && resendHelps && attempt < MAX_RETRIES) {
                await sleep(retryDelayMs(attempt, retryAfter), signal);
                continue;
            }
            if (failed) {
                const message = typeof envelope.msg === 'string' && envelope.msg
                    ? envelope.msg
                    : (envelope.error?.message || `Request failed with HTTP ${status}.`);
                throw new SpicyApiError(message, { status, code, requestId: String(envelope.request_id || '') });
            }
            if (!('data' in envelope)) {
                throw new SpicyApiError('A successful response carried no data.', { status });
            }
            return envelope.data;
        }
    }

    // -- Catalogue and account ---------------------------------------------

    /**
     * @param {{modality?: string, includeSchema?: boolean, signal?: AbortSignal}} [options]
     * @returns {Promise<any[]>}
     */
    async listModels({ modality, includeSchema = false, signal } = {}) {
        const query = new URLSearchParams();
        if (modality) query.set('modality', modality);
        if (includeSchema) query.set('includeSchema', '1');
        const suffix = query.toString() ? `?${query}` : '';
        const data = await this.request('GET', `/api/v1/models${suffix}`, { signal });
        const items = Array.isArray(data?.items) ? data.items : [];
        return items.filter(item => item && typeof item === 'object' && typeof item.model === 'string');
    }

    /** @returns {Promise<{available: string, held: string, total: string}>} */
    balance({ signal } = {}) {
        return this.request('GET', '/api/v1/chat/credit', { signal });
    }

    // -- Tasks ---------------------------------------------------------------

    /** Free: validates the input and returns the price without reserving funds. */
    quote(model, input, { signal } = {}) {
        return this.request('POST', '/api/v1/jobs/quote', { body: { model, input }, signal });
    }

    /**
     * Submits one task. Every resend of the same submission must reuse the same idempotency key.
     * @param {string} model
     * @param {Record<string, any>} input
     * @param {{idempotencyKey: string, quoteId?: string, expectedCost?: string, waitSeconds?: number, signal?: AbortSignal}} options
     */
    createTask(model, input, { idempotencyKey, quoteId, expectedCost, waitSeconds = 0, signal }) {
        const body = { model, input };
        if (quoteId) body.quoteId = quoteId;
        if (expectedCost) body.expectedCost = expectedCost;
        const wait = Math.max(0, Math.min(60, Math.floor(waitSeconds || 0)));
        const path = wait > 0 ? `/api/v1/jobs/createTask?wait=${wait}` : '/api/v1/jobs/createTask';
        return this.request('POST', path, {
            body,
            headers: { 'Idempotency-Key': idempotencyKey },
            timeoutMs: REQUEST_TIMEOUT_MS + wait * 1000,
            signal,
        });
    }

    getTask(taskId, { signal } = {}) {
        return this.request('GET', `/api/v1/jobs/recordInfo?${new URLSearchParams({ taskId })}`, { signal });
    }

    /**
     * Polls until the task is terminal and every output file has a URL.
     * @param {string} taskId
     * @param {{timeoutMs?: number, intervalMs?: number, onUpdate?: (task: any, elapsedMs: number) => void, signal?: AbortSignal, initial?: any}} [options]
     */
    async waitForTask(taskId, { timeoutMs = 65 * 60_000, intervalMs = 2000, onUpdate, signal, initial } = {}) {
        const started = Date.now();
        let interval = intervalMs;
        let task = initial && TERMINAL_STATES.has(initial.state) ? initial : null;
        for (;;) {
            if (task) {
                onUpdate?.(task, Date.now() - started);
                const state = task.state;
                if (TERMINAL_STATES.has(state) && !hasPendingAssets(task)) {
                    return task;
                }
                if (!TERMINAL_STATES.has(state) && !ACTIVE_STATES.has(state)) {
                    throw new SpicyApiError(`Unknown task state ${state} for task ${taskId}.`);
                }
            }
            if (Date.now() - started > timeoutMs) {
                throw new SpicyApiError(
                    `Task ${taskId} did not finish within ${Math.round(timeoutMs / 60_000)} minutes. It may still be running; insert it later with /spicy-task ${taskId}.`,
                    { kind: 'timeout' },
                );
            }
            await sleep(task ? interval : 0, signal);
            if (task) interval = Math.min(interval * 1.5, Math.max(intervalMs, 10_000));
            try {
                task = await this.getTask(taskId, { signal });
            } catch (error) {
                // One failed poll is not a failed task: keep polling while the budget lasts.
                if (error instanceof SpicyApiError && (error.kind === 'aborted' || (error.status && error.status < 500 && error.status !== 408 && error.status !== 429))) {
                    throw error;
                }
                task = null;
                await sleep(interval, signal);
            }
        }
    }

    // -- Files ---------------------------------------------------------------

    /**
     * Downloads an output file. The signed URL is its own credential; no API key is attached.
     * @param {string} url
     * @param {{signal?: AbortSignal}} [options]
     * @returns {Promise<Blob>}
     */
    async download(url, { signal } = {}) {
        let lastError = null;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            const timer = timeoutSignal(DOWNLOAD_TIMEOUT_MS, signal);
            try {
                const response = await this.send(url, { method: 'GET', signal: timer.signal });
                if (response.ok) {
                    const blob = await response.blob();
                    timer.done();
                    return blob;
                }
                timer.done();
                lastError = new SpicyApiError(`Downloading the result failed with HTTP ${response.status}.`, { status: response.status });
                if (!RETRYABLE_HTTP.has(response.status)) break;
            } catch (error) {
                timer.done();
                if (signal?.aborted) throw abortedError(signal);
                lastError = error;
                if (error instanceof SpicyApiError && error.kind !== 'timeout') break;
            }
            if (attempt < MAX_RETRIES) await sleep(retryDelayMs(attempt, null), signal);
        }
        throw lastError || new SpicyApiError('Downloading the result failed.');
    }
}

/** A succeeded task can still have output files that have not landed yet. */
export function hasPendingAssets(task) {
    if (task?.state !== 'succeeded') return false;
    return outputAssets(task).some(asset => asset.pending && !asset.unavailable);
}

/** @returns {Array<{url?: string, mime?: string, pending?: boolean, unavailable?: boolean, width?: number, height?: number, durationSeconds?: number}>} */
export function outputAssets(task) {
    const assets = task?.output?.assets;
    return Array.isArray(assets) ? assets.filter(asset => asset && typeof asset === 'object') : [];
}
