import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    SpicyApiError,
    SpicyClient,
    SpicyTaskError,
    formatUsd,
    normalizeBaseUrl,
    proxyUrl,
    usdToNumber,
} from '../src/client.js';

function jsonResponse(body, status = 200, headers = {}) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function envelope(data, code = 200, msg = 'success') {
    return { code, msg, data, request_id: 'req_test' };
}

/** A fetch stand-in that records calls and answers from a queue of handlers. */
function fakeFetch(...handlers) {
    const calls = [];
    const impl = async (url, init = {}) => {
        calls.push({ url: String(url), init });
        const handler = handlers.length > 1 ? handlers.shift() : handlers[0];
        return handler(String(url), init);
    };
    impl.calls = calls;
    return impl;
}

test('proxyUrl encodes the whole target so the query string survives', () => {
    const url = proxyUrl('http://127.0.0.1:8000/', 'https://api.spicyapi.ai/api/v1/jobs/recordInfo?taskId=job_1');
    assert.equal(url, 'http://127.0.0.1:8000/proxy/https%3A%2F%2Fapi.spicyapi.ai%2Fapi%2Fv1%2Fjobs%2FrecordInfo%3FtaskId%3Djob_1');
    assert.equal(decodeURIComponent(url.split('/proxy/')[1]), 'https://api.spicyapi.ai/api/v1/jobs/recordInfo?taskId=job_1');
});

test('normalizeBaseUrl strips trailing slashes and API suffixes', () => {
    assert.equal(normalizeBaseUrl(''), 'https://api.spicyapi.ai');
    assert.equal(normalizeBaseUrl('https://api.spicyapi.ai/'), 'https://api.spicyapi.ai');
    assert.equal(normalizeBaseUrl('https://api.spicyapi.ai/v1'), 'https://api.spicyapi.ai');
    assert.equal(normalizeBaseUrl('https://api.spicyapi.ai/api/v1/'), 'https://api.spicyapi.ai');
});

test('formatUsd keeps every significant digit and at least cents', () => {
    assert.equal(formatUsd('0.01'), '$0.01');
    assert.equal(formatUsd('0.0246078'), '$0.0246078');
    assert.equal(formatUsd('1.5'), '$1.50');
    assert.equal(formatUsd('2'), '$2.00');
    assert.equal(formatUsd('0.120000'), '$0.12');
    assert.equal(usdToNumber('0.045'), 0.045);
    assert.equal(usdToNumber('n/a'), null);
});

test('request returns data and sends the key only to the API', async () => {
    const fetch = fakeFetch(() => jsonResponse(envelope({ available: '1.50', held: '0', total: '1.50' })));
    const client = new SpicyClient({ apiKey: 'sk-spicy-test', transport: 'direct', fetch });
    const balance = await client.balance();
    assert.equal(balance.available, '1.50');
    assert.equal(fetch.calls[0].url, 'https://api.spicyapi.ai/api/v1/chat/credit');
    assert.equal(fetch.calls[0].init.headers.Authorization, 'Bearer sk-spicy-test');
    assert.equal(client.lastRoute, 'direct');
});

test('an API error keeps the server message, code and request id', async () => {
    const fetch = fakeFetch(() => jsonResponse({ code: 40004, msg: 'resolution: 4k is not served', data: null, request_id: 'req_abc' }, 400));
    const client = new SpicyClient({ apiKey: 'k', transport: 'direct', fetch });
    await assert.rejects(client.quote('m', { prompt: 'x' }), error => {
        assert.ok(error instanceof SpicyApiError);
        assert.equal(error.code, 40004);
        assert.equal(error.status, 400);
        assert.match(error.describe(), /resolution: 4k is not served/);
        assert.match(error.describe(), /request_id req_abc/);
        return true;
    });
    assert.equal(fetch.calls.length, 1, 'a 400 is not retried');
});

test('a 503 is retried and then succeeds', async () => {
    const fetch = fakeFetch(
        () => jsonResponse({ code: 503, msg: 'busy', request_id: 'r' }, 503, { 'Retry-After': '0' }),
        () => jsonResponse(envelope({ items: [] })),
    );
    const client = new SpicyClient({ apiKey: 'k', transport: 'direct', fetch });
    const items = await client.listModels({ modality: 'image', includeSchema: true });
    assert.deepEqual(items, []);
    assert.equal(fetch.calls.length, 2);
    assert.equal(fetch.calls[1].url, 'https://api.spicyapi.ai/api/v1/models?modality=image&includeSchema=1');
});

test('auto mode falls back to the SillyTavern proxy when the browser cannot reach the API', async () => {
    const fetch = fakeFetch(
        () => { throw new TypeError('Failed to fetch'); },
        () => jsonResponse(envelope({ quoteId: 'q', estimatedCost: '0.01', maxCharge: '0.01' })),
        () => jsonResponse(envelope({ quoteId: 'q2', estimatedCost: '0.01', maxCharge: '0.01' })),
    );
    const client = new SpicyClient({
        apiKey: 'k',
        transport: 'auto',
        origin: 'http://127.0.0.1:8765',
        stHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'csrf' }),
        fetch,
    });
    const quote = await client.quote('alibaba/z-image-turbo/text-to-image', { prompt: 'a lighthouse' });
    assert.equal(quote.quoteId, 'q');
    assert.equal(fetch.calls.length, 2);
    assert.ok(fetch.calls[1].url.startsWith('http://127.0.0.1:8765/proxy/https%3A%2F%2Fapi.spicyapi.ai'));
    assert.equal(fetch.calls[1].init.headers.Authorization, 'Bearer k');
    assert.equal(fetch.calls[1].init.headers['X-CSRF-Token'], 'csrf');
    assert.equal(client.lastRoute, 'proxy');
    // Later calls to the same host go straight to the proxy instead of failing the direct route again.
    await client.quote('alibaba/z-image-turbo/text-to-image', { prompt: 'a lighthouse' });
    assert.equal(fetch.calls.length, 3);
    assert.ok(fetch.calls[2].url.includes('/proxy/'));
    assert.ok(client.proxiedHosts.has('api.spicyapi.ai'));
});

test('the proxy fallback is remembered per host', async () => {
    const fetch = fakeFetch(
        () => { throw new TypeError('Failed to fetch'); },
        () => new Response(new Uint8Array([1]), { status: 200, headers: { 'Content-Type': 'image/png' } }),
        () => jsonResponse(envelope({ available: '1', held: '0', total: '1' })),
    );
    const client = new SpicyClient({ apiKey: 'k', transport: 'auto', origin: 'http://localhost:8000', fetch });
    await client.download('https://files.example/x.png?sig=1');
    assert.ok(client.proxiedHosts.has('files.example'));
    await client.balance();
    assert.equal(fetch.calls[2].url, 'https://api.spicyapi.ai/api/v1/chat/credit', 'the API host is still tried directly');
});

test('a disabled proxy is reported with how to enable it', async () => {
    const fetch = fakeFetch(() => new Response('CORS proxy is disabled. Enable it in config.yaml or use the --corsProxy flag.', { status: 404 }));
    const client = new SpicyClient({ apiKey: 'k', transport: 'proxy', origin: 'http://localhost:8000', fetch });
    await assert.rejects(client.balance(), error => {
        assert.equal(error.kind, 'proxy-disabled');
        assert.match(error.message, /enableCorsProxy/);
        return true;
    });
});

test('direct mode explains a CORS or network failure', async () => {
    const fetch = fakeFetch(() => { throw new TypeError('Failed to fetch'); });
    const client = new SpicyClient({ apiKey: 'k', transport: 'direct', fetch });
    await assert.rejects(client.balance(), error => {
        assert.equal(error.kind, 'network');
        assert.match(error.message, /CORS/);
        return true;
    });
    assert.equal(fetch.calls.length, 1);
});

test('createTask sends the idempotency key, quote and wait', async () => {
    const fetch = fakeFetch(() => jsonResponse(envelope({ taskId: 'job_1', state: 'queued', estimatedCost: '0.01' })));
    const client = new SpicyClient({ apiKey: 'k', transport: 'direct', fetch });
    await client.createTask('m', { prompt: 'p' }, { idempotencyKey: 'idem-1', quoteId: 'q', expectedCost: '0.01', waitSeconds: 20 });
    const call = fetch.calls[0];
    assert.equal(call.url, 'https://api.spicyapi.ai/api/v1/jobs/createTask?wait=20');
    assert.equal(call.init.headers['Idempotency-Key'], 'idem-1');
    assert.deepEqual(JSON.parse(call.init.body), { model: 'm', input: { prompt: 'p' }, quoteId: 'q', expectedCost: '0.01' });
});

test('waitForTask polls until the task and its files are ready', async () => {
    const states = [
        { taskId: 'job_1', state: 'running' },
        { taskId: 'job_1', state: 'succeeded', output: { assets: [{ pending: true }] } },
        { taskId: 'job_1', state: 'succeeded', cost: '0.01', settled: true, output: { assets: [{ url: 'https://files.example/x.png', mime: 'image/png' }] } },
    ];
    const fetch = fakeFetch(() => jsonResponse(envelope(states.shift())));
    const client = new SpicyClient({ apiKey: 'k', transport: 'direct', fetch });
    const seen = [];
    const task = await client.waitForTask('job_1', { initial: { taskId: 'job_1', state: 'queued' }, intervalMs: 1, onUpdate: t => seen.push(t.state) });
    assert.equal(task.state, 'succeeded');
    assert.equal(task.output.assets[0].url, 'https://files.example/x.png');
    assert.deepEqual(seen, ['running', 'succeeded', 'succeeded']);
    assert.equal(fetch.calls[0].url, 'https://api.spicyapi.ai/api/v1/jobs/recordInfo?taskId=job_1');
});

test('a finished task returned by createTask needs no polling', async () => {
    const fetch = fakeFetch(() => { throw new Error('should not poll'); });
    const client = new SpicyClient({ apiKey: 'k', transport: 'direct', fetch });
    const done = { taskId: 'job_2', state: 'failed', errorCode: 'content_rejected', errorMessage: 'declined' };
    const task = await client.waitForTask('job_2', { initial: done });
    assert.equal(task.state, 'failed');
    const error = new SpicyTaskError(task);
    assert.match(error.describe(), /content_rejected: declined/);
    assert.match(error.describe(), /job_2/);
});

test('download does not send the API key', async () => {
    const fetch = fakeFetch(() => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'Content-Type': 'image/png' } }));
    const client = new SpicyClient({ apiKey: 'k', transport: 'direct', fetch });
    const blob = await client.download('https://files.example/x.png?sig=1');
    assert.equal(blob.size, 3);
    assert.equal(fetch.calls[0].init.headers, undefined);
});

test('a missing key is a configuration error, not a request', async () => {
    const fetch = fakeFetch(() => { throw new Error('should not be called'); });
    const client = new SpicyClient({ apiKey: '', transport: 'direct', fetch });
    await assert.rejects(client.balance(), /No SpicyAPI key/);
    assert.equal(fetch.calls.length, 0);
});
