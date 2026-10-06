/**
 * SpicyAPI for SillyTavern.
 *
 * Generates pictures and videos with SpicyAPI models from inside a chat: slash commands, wand
 * menu entries and an Animate button on pictures. Every run is priced first, checked against the
 * user's spending limits, and the result is saved into SillyTavern and attached to the chat.
 *
 * Optionally the AI can show a picture on its own, through a function tool or a tag in its reply,
 * behind a per-chat cooldown and a daily cap. Automatic runs are always pictures, never videos.
 */

import {
    DEFAULT_BASE_URL,
    SpicyApiError,
    SpicyClient,
    SpicyTaskError,
    TERMINAL_STATES,
    TRANSPORTS,
    formatUsd,
    newIdempotencyKey,
    normalizeBaseUrl,
    outputAssets,
    usdToNumber,
} from './src/client.js';
import {
    KINDS,
    acceptsReference,
    automaticModel,
    buildInput,
    describeStartingPrice,
    fitsKind,
    groupedModels,
    modelLabel,
    optionFields,
    priceTable,
    requiresImage,
    validOptionValue,
} from './src/catalog.js';
import { mediaTypeForMime, pictureForApi, saveToSillyTavern, withMime } from './src/media.js';
import {
    DEFAULT_EVERY,
    DEFAULT_TAG,
    TOOL_NAME,
    capAllows,
    cooldownAllows,
    countReplies,
    createDailySpendStore,
    normalizeTagName,
    parseEvery,
    stripPictureTags,
    tagInstruction,
} from './src/auto.js';

const MODULE = 'spicyapi';
const LOG_PREFIX = '[SpicyAPI]';
const CREATE_WAIT_SECONDS = 20;
const PRICE_CHECK_PROMPT = 'price check';

const DEFAULT_SETTINGS = Object.freeze({
    apiKey: '',
    baseUrl: DEFAULT_BASE_URL,
    transport: TRANSPORTS.AUTO,
    imageModel: '',
    t2vModel: '',
    i2vModel: '',
    chatModel: '',
    modelOptions: {},
    useAvatar: false,
    reviewPrompts: true,
    visibleToAi: false,
    confirmAbove: 0.1,
    maxPerRun: 1,
    chatSecretId: '',
    // The AI shows pictures on its own (off by default).
    autoPictures: false,
    autoTool: true,
    autoTag: false,
    autoTagName: DEFAULT_TAG,
    autoTagInject: true,
    autoEvery: DEFAULT_EVERY,
    autoDailyCap: 0.5,
    autoAboveConfirm: 'ask',
});

const AUTO_SPEND_STORAGE_KEY = 'spicyapi_auto_spend';
const INSTRUCTION_KEY = 'spicyapi_picture_tag';
// SillyTavern's extension prompt position "in chat" and role "system" (script.js).
const PROMPT_IN_CHAT = 1;
const PROMPT_ROLE_SYSTEM = 0;
const INSTRUCTION_DEPTH = 1;
// Messages that never start an automatic picture: SillyTavern's own quiet and impersonated
// generations, greetings, and messages posted by commands or extensions.
const NO_AUTO_TYPES = new Set(['quiet', 'impersonate', 'first_message', 'command', 'extension']);

// Neutral instructions for the chat model when it writes the prompt. The extension ships no
// prompt presets, styles or example content of its own.
const WRITE_INSTRUCTIONS = {
    image: 'Pause the story; do not continue it. Write one prompt for an image generator that shows the current moment of this scene as a single picture. Describe who is in the frame and how they look (from the character descriptions, not by name), what they are doing, their expressions, the setting, the lighting and the camera framing. Use concrete visual words and no dialogue. Keep it under 90 words. Reply with the prompt only.',
    t2v: 'Pause the story; do not continue it. Write one prompt for a text-to-video generator that shows the next few seconds of this scene. Describe who is in the frame and how they look (from the character descriptions, not by name), what they do, the camera movement, the setting, the lighting and the sound. Keep it under 90 words. Reply with the prompt only.',
    i2v: 'Pause the story; do not continue it. A picture from this scene is about to be turned into a short video clip. Write one prompt for an image-to-video generator that describes only what happens in the clip: the movement, the expressions, the camera movement and the ambient sound, matching the current moment of the story. Do not describe the picture itself. Keep it under 60 words. Reply with the prompt only.',
};

const KIND_NOUN = { image: 'picture', t2v: 'video', i2v: 'video' };
const SETTING_KEY_BY_KIND = { image: 'imageModel', t2v: 't2vModel', i2v: 'i2vModel', chat: 'chatModel' };

/** Catalogue cache for this page load. */
const catalog = {
    /** @type {any[]} */
    items: [],
    loaded: false,
    /** @type {Promise<any[]>|null} */
    loading: null,
    error: '',
};

const session = { spent: 0, runs: 0 };

/** Browser storage, or null where it is blocked (some private windows). */
function browserStorage() {
    try {
        return globalThis.localStorage ?? null;
    } catch {
        return null;
    }
}

// What automatic pictures cost today, kept in this browser.
const autoSpend = createDailySpendStore(browserStorage(), AUTO_SPEND_STORAGE_KEY);

// -- Small helpers ----------------------------------------------------------

function ctx() {
    return SillyTavern.getContext();
}

function settings() {
    const store = ctx().extensionSettings;
    if (!store[MODULE] || typeof store[MODULE] !== 'object') {
        store[MODULE] = structuredClone(DEFAULT_SETTINGS);
    }
    const current = store[MODULE];
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (!(key in current)) current[key] = structuredClone(value);
    }
    if (!current.modelOptions || typeof current.modelOptions !== 'object') current.modelOptions = {};
    return current;
}

function save() {
    ctx().saveSettingsDebounced();
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

let cachedClient = null;

/**
 * The API client for the current settings. One instance is kept per key, address and route, so
 * that once Auto has fallen back to the proxy it stays there for the rest of the page session.
 */
function client() {
    const s = settings();
    const signature = JSON.stringify([s.apiKey, s.baseUrl, s.transport]);
    if (!cachedClient || cachedClient.signature !== signature) {
        cachedClient = new SpicyClient({
            apiKey: s.apiKey,
            baseUrl: s.baseUrl,
            transport: s.transport,
            stHeaders: () => ctx().getRequestHeaders(),
        });
        cachedClient.signature = signature;
    }
    return cachedClient;
}

function describeError(error) {
    if (error instanceof SpicyApiError || error instanceof SpicyTaskError) return error.describe();
    return error?.message || String(error);
}

function showError(error, title = 'SpicyAPI') {
    console.error(LOG_PREFIX, error);
    toastr.error(describeError(error), title, { timeOut: 20000, extendedTimeOut: 20000, escapeHtml: true });
}

class Cancelled extends Error {
    constructor(message = 'Cancelled.') {
        super(message);
        this.name = 'Cancelled';
    }
}

/** An automatic picture that was not made, with the reason in words the chat model can read. */
class Skipped extends Cancelled {
    /**
     * @param {string} reason Completes "No picture was shown because ..."
     * @param {{notify?: boolean}} [options] Tell the user with a toast
     */
    constructor(reason, { notify = false } = {}) {
        super(`Skipped: ${reason}.`);
        this.name = 'Skipped';
        this.reason = reason;
        this.notify = notify;
    }
}

class OverLimit extends Error {
    constructor(message) {
        super(message);
        this.name = 'OverLimit';
    }
}

function parseLimit(value) {
    if (value === '' || value === null || value === undefined) return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
}

/** The most this quote can charge. */
function worstCase(quote) {
    return usdToNumber(quote?.maxCharge) ?? usdToNumber(quote?.estimatedCost) ?? 0;
}

/** A balance to the cent: $1.66 rather than $1.663185419. */
function formatBalance(value) {
    const number = usdToNumber(value);
    return number === null ? formatUsd(value) : `$${(Math.floor(number * 100) / 100).toFixed(2)}`;
}

function describeQuote(quote) {
    const estimate = formatUsd(quote.estimatedCost);
    const max = usdToNumber(quote.maxCharge);
    if (max !== null && max > (usdToNumber(quote.estimatedCost) ?? 0)) {
        return `${estimate} (up to ${formatUsd(quote.maxCharge)})`;
    }
    return estimate;
}

// -- Catalogue ---------------------------------------------------------------

/** Loads the image, video and chat models once per page (or again with force). */
async function loadCatalog({ force = false } = {}) {
    if (catalog.loaded && !force) return catalog.items;
    if (catalog.loading && !force) return catalog.loading;
    const api = client();
    catalog.loading = (async () => {
        try {
            const [images, videos, texts] = await Promise.all([
                api.listModels({ modality: 'image', includeSchema: true }),
                api.listModels({ modality: 'video', includeSchema: true }),
                api.listModels({ modality: 'text' }),
            ]);
            catalog.items = [...images, ...videos, ...texts];
            catalog.loaded = true;
            catalog.error = '';
            return catalog.items;
        } catch (error) {
            catalog.error = describeError(error);
            throw error;
        } finally {
            catalog.loading = null;
        }
    })();
    return catalog.loading;
}

function findModel(id) {
    return catalog.items.find(model => model.model === id) || null;
}

/** The model to use for a job: the one asked for, the saved choice, or the automatic pick. */
async function resolveModel(kind, requested) {
    await loadCatalog();
    if (requested) {
        const model = findModel(requested);
        if (!model) throw new Error(`There is no model called ${requested}. Check the id in the SpicyAPI settings.`);
        if (!fitsKind(model, kind)) throw new Error(`${model.displayName || requested} cannot make a ${KINDS[kind].label.toLowerCase()} here.`);
        return model;
    }
    const saved = settings()[SETTING_KEY_BY_KIND[kind]];
    if (saved) {
        const model = findModel(saved);
        if (model && fitsKind(model, kind)) return model;
        toastr.warning(`${saved} is no longer available; using the automatic choice instead.`, 'SpicyAPI');
    }
    const automatic = automaticModel(catalog.items, kind);
    if (!automatic) throw new Error(`No ${KINDS[kind].label.toLowerCase()} model is available right now.`);
    return automatic;
}

function optionsFor(model) {
    const saved = settings().modelOptions[model.model] || {};
    const options = {};
    for (const field of optionFields(model)) {
        const value = validOptionValue(field, saved[field.name]);
        if (value !== undefined) options[field.name] = value;
    }
    return options;
}

// -- Chat helpers ------------------------------------------------------------

/** The current character's avatar URL, or null in a group chat or without a character. */
function currentAvatarUrl() {
    const context = ctx();
    if (context.groupId || context.characterId === undefined) return null;
    const avatar = context.characters?.[context.characterId]?.avatar;
    if (!avatar || avatar === 'none') return null;
    return `/characters/${encodeURIComponent(avatar)}`;
}

function folderName() {
    const context = ctx();
    if (context.groupId) {
        const group = context.groups?.find(item => String(item.id) === String(context.groupId));
        return group?.name || 'SpicyAPI';
    }
    return context.name2 || 'SpicyAPI';
}

function speakerName() {
    const context = ctx();
    if (context.groupId || context.characterId === undefined) return 'SpicyAPI';
    return context.name2 || 'SpicyAPI';
}

/** The picture a message shows: the selected one in a gallery, otherwise the last picture. */
function pictureOfMessage(message) {
    if (!message) return null;
    ctx().ensureMessageMediaIsArray?.(message);
    const media = Array.isArray(message.extra?.media) ? message.extra.media : [];
    const selected = media[message.extra?.media_index];
    if (selected?.url && (selected.type ?? 'image') === 'image') return selected.url;
    const last = [...media].reverse().find(item => item?.url && (item.type ?? 'image') === 'image');
    return last?.url || null;
}

/** The most recent picture in the chat, with the message it belongs to. */
function latestPicture() {
    const chat = ctx().chat || [];
    for (let id = chat.length - 1; id >= 0; id--) {
        const url = pictureOfMessage(chat[id]);
        if (url) return { url, messageId: id };
    }
    return null;
}

function cleanWrittenPrompt(text) {
    let prompt = String(text || '').trim();
    // A model told to use picture tags may answer with one; keep its description.
    const tagged = stripPictureTags(prompt, settings().autoTagName);
    if (tagged.changed) prompt = tagged.text || tagged.prompts[0] || '';
    prompt = prompt.replace(/^```[a-z]*\s*/i, '').replace(/```$/, '').trim();
    prompt = prompt.replace(/^(image |video )?prompt\s*:\s*/i, '').trim();
    prompt = prompt.replace(/^["'“”]+|["'“”]+$/g, '').trim();
    return prompt.replace(/\s+/g, ' ');
}

/** Asks the connected chat model to write the prompt (SillyTavern's quiet generation). */
async function writePrompt(kind) {
    const context = ctx();
    if (context.onlineStatus === 'no_connection') {
        throw new Error('No chat model is connected, so the prompt cannot be written for you. Connect one, or type a prompt.');
    }
    const instruction = context.substituteParams(`[${WRITE_INSTRUCTIONS[kind]}]`);
    let text;
    try {
        // Leave room for reasoning models: their thinking counts against the response length.
        const configured = Number(context.chatCompletionSettings?.openai_max_tokens);
        const responseLength = context.mainApi === 'openai' && Number.isFinite(configured) && configured < 1024 ? 1024 : null;
        text = await context.generateQuietPrompt({ quietPrompt: instruction, skipWIAN: false, removeReasoning: true, responseLength });
    } catch (error) {
        throw new Error(`The connected chat model could not write the prompt (${error?.message || error}). Type a prompt instead, or check the chat connection.`);
    }
    const prompt = cleanWrittenPrompt(text);
    if (!prompt) {
        throw new Error('The chat API returned no prompt. Check that a chat model is connected and selected in API Connections (and that its response length is not too low), or type a prompt.');
    }
    return prompt;
}

// -- Popups ------------------------------------------------------------------

/**
 * Lets the user type or edit the prompt. With `autoWrite`, the chat model starts writing it from
 * the scene as soon as the popup opens; the user can type over it at any time.
 * @returns {Promise<string|null>} The prompt, or null when cancelled.
 */
async function composePrompt({ kind, model, initial = '', autoWrite = false, preview = null }) {
    const context = ctx();
    const canWrite = context.onlineStatus !== 'no_connection';
    const price = preview ? `This run costs ${describeQuote(preview)}.` : describeStartingPrice(model);
    const header = `
        <div class="spicyapi-compose">
            <h3>SpicyAPI ${escapeHtml(KIND_NOUN[kind])}</h3>
            <div class="spicyapi-compose-model">${escapeHtml(model.displayName || model.model)}</div>
            <div class="spicyapi-compose-price">${escapeHtml(price)}</div>
            <small>${escapeHtml(composeHint(kind, model))}${canWrite ? ' Or let the connected chat model write it from the scene.' : ''}</small>
        </div>`;
    let popup;
    let writing = false;
    const write = async () => {
        if (writing || !popup) return;
        writing = true;
        const input = popup.mainInput;
        const before = input.value;
        input.placeholder = 'Writing a prompt from the scene...';
        input.classList.add('spicyapi-writing');
        try {
            const text = await writePrompt(kind);
            // Do not overwrite anything the user typed while the model was writing.
            if (input.value === before) {
                input.value = text;
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }
        } catch (error) {
            showError(error);
        } finally {
            input.placeholder = '';
            input.classList.remove('spicyapi-writing');
            writing = false;
        }
    };
    const customButtons = canWrite
        ? [{ text: 'Write from the scene', icon: 'fa-wand-magic-sparkles', action: () => { write(); } }]
        : [];
    popup = new context.Popup(header, context.POPUP_TYPE.INPUT, initial, {
        rows: 6,
        okButton: preview ? `Generate for ${formatUsd(preview.estimatedCost)}` : 'Generate',
        cancelButton: 'Cancel',
        wide: false,
        customButtons,
        onOpen: () => {
            if (autoWrite && canWrite && !initial) write();
        },
    });
    const result = await popup.show();
    if (result === null || result === false || result === undefined || result === '') {
        return typeof result === 'string' ? '' : null;
    }
    return String(result);
}

function composeHint(kind, model) {
    if (kind === 'i2v') return 'Describe the motion, the camera and the sound.';
    if (kind === 'image' && requiresImage(model)) return 'Describe how to change the character avatar.';
    return 'Describe what should be seen.';
}

function shorten(text, max) {
    const value = String(text || '');
    return value.length > max ? `${value.slice(0, max - 3).trimEnd()}...` : value;
}

/**
 * Asks before a run above the confirmation amount. For an automatic picture the popup says that
 * the AI asked for it and shows the description it wrote.
 */
async function confirmSpend(model, quote, { auto = false, prompt = '' } = {}) {
    const context = ctx();
    const heading = auto ? `The AI wants to show a picture for ${describeQuote(quote)}` : `Spend ${describeQuote(quote)}?`;
    const description = auto && prompt ? `<div class="spicyapi-confirm-prompt">${escapeHtml(shorten(prompt, 400))}</div>` : '';
    const result = await context.callGenericPopup(
        `<div class="spicyapi-confirm">
            <h3>${escapeHtml(heading)}</h3>
            <div>${escapeHtml(model.displayName || model.model)}</div>
            ${description}
            <small>This is above your confirmation amount in the SpicyAPI settings.</small>
        </div>`,
        context.POPUP_TYPE.CONFIRM,
        '',
        { okButton: `Generate for ${formatUsd(quote.estimatedCost)}`, cancelButton: auto ? 'Skip' : 'Cancel' },
    );
    if (result !== context.POPUP_RESULT.AFFIRMATIVE) throw new Cancelled();
}

function enforceLimit(quote) {
    const limit = parseLimit(settings().maxPerRun);
    const worst = worstCase(quote);
    if (limit !== null && worst > limit) {
        throw new OverLimit(`This run could cost up to ${formatUsd(String(worst))}, above your limit of ${formatUsd(String(limit))} per generation (Extensions > SpicyAPI). Nothing was charged.`);
    }
}

function overConfirmAmount(quote) {
    const threshold = parseLimit(settings().confirmAbove);
    return threshold !== null && worstCase(quote) > threshold;
}

// What automatic pictures that are still running could cost, so two of them at once cannot
// both squeeze under the daily cap.
let autoReserved = 0;

function holdAutoSpend(hold, amount) {
    autoReserved = Math.max(0, autoReserved + amount - hold.amount);
    hold.amount = amount;
}

function releaseAutoSpend(hold) {
    autoReserved = Math.max(0, autoReserved - hold.amount);
    hold.amount = 0;
}

/**
 * The extra checks for an automatic picture once its exact price is known: the daily cap (the
 * worst case is then held against it until the run ends), then the confirmation amount (ask or
 * skip, as the user chose).
 * @param {{amount: number}} hold This run's share of the held amount
 */
async function gateAutoRun(model, quote, prompt, hold) {
    const s = settings();
    const cap = parseLimit(s.autoDailyCap);
    const othersHeld = Math.max(0, autoReserved - hold.amount);
    if (!capAllows({ spent: autoSpend.spentToday() + othersHeld, cost: worstCase(quote), cap })) {
        throw new Skipped(`it would go over today's limit for automatic pictures (${formatUsd(String(cap))})`, { notify: true });
    }
    holdAutoSpend(hold, worstCase(quote));
    if (!overConfirmAmount(quote)) return;
    if (s.autoAboveConfirm === 'skip') {
        throw new Skipped(`its price (${describeQuote(quote)}) is above the confirmation amount`, { notify: true });
    }
    try {
        await confirmSpend(model, quote, { auto: true, prompt });
    } catch (error) {
        if (error instanceof Cancelled) throw new Skipped('the user chose not to generate it');
        throw error;
    }
}

// -- Progress ----------------------------------------------------------------

function startProgress(title, onStop) {
    const id = `spicyapi_progress_${Math.random().toString(36).slice(2)}`;
    const toast = toastr.info(
        `<div id="${id}"><span class="spicyapi-progress-text">${escapeHtml(title)}</span>
         <div><a href="javascript:void(0)" class="spicyapi-stop">Stop waiting</a></div></div>`,
        'SpicyAPI',
        { timeOut: 0, extendedTimeOut: 0, tapToDismiss: false, closeButton: false, escapeHtml: false },
    );
    toast?.find?.('.spicyapi-stop').on('click', event => {
        event.preventDefault();
        event.stopPropagation();
        onStop();
    });
    return {
        update(text) {
            toast?.find?.('.spicyapi-progress-text').text(text);
        },
        stopLinkHidden() {
            toast?.find?.('.spicyapi-stop').remove();
        },
        close() {
            if (toast) toastr.clear(toast);
        },
    };
}

// -- Generation pipeline -----------------------------------------------------

/**
 * Runs one generation from start to finish.
 * @param {object} job
 * @param {'image'|'t2v'|'i2v'} job.kind
 * @param {string} [job.prompt] Typed prompt; empty means "write it from the scene"
 * @param {string} [job.modelId] Model id from a command argument
 * @param {string} [job.imageUrl] Picture to animate (i2v)
 * @param {boolean} [job.useAvatar] Overrides the avatar setting (image)
 * @param {boolean} [job.edit] Always open the prompt editor
 * @param {boolean} [job.quiet] Save the result but do not post it to the chat
 * @param {number} [job.appendTo] Message id to attach the result to instead of posting a new message
 * @param {boolean} [job.waitForIdle] Wait until SillyTavern is not generating before posting
 * @param {boolean} [job.auto] An automatic picture: no editor, and the daily cap and the
 *   ask-or-skip choice apply
 * @param {{amount: number}} [job.autoHold] For automatic pictures: what this run holds against
 *   the daily cap; the caller releases it
 * @param {(usd: number) => void} [job.onCharge] Called once with what the run cost, or with the
 *   estimate when it was submitted but its outcome is unknown
 * @returns {Promise<string>} Local path of the saved result
 */
async function generate(job) {
    const s = settings();
    const kind = job.kind;
    const api = client();
    const context = ctx();
    const chatIdAtStart = context.getCurrentChatId?.();

    const model = await resolveModel(kind, job.modelId);
    const options = optionsFor(model);

    let image;
    let reference;
    if (kind === 'i2v') {
        if (!job.imageUrl) throw new Error('There is no picture to animate.');
        image = await pictureForApi(job.imageUrl);
    } else if (kind === 'image') {
        const needsPicture = requiresImage(model);
        const wantsAvatar = job.useAvatar ?? s.useAvatar;
        if (needsPicture || (wantsAvatar && acceptsReference(model))) {
            const avatar = currentAvatarUrl();
            if (avatar) reference = await pictureForApi(avatar);
        }
    }

    // 1. The prompt: typed, written by the chat model, or composed in the popup.
    let prompt = String(job.prompt || '').trim();
    let shownWorst = null;
    const canWrite = context.onlineStatus !== 'no_connection';
    if (job.edit || (!prompt && (s.reviewPrompts || !canWrite))) {
        // Price it with a stand-in prompt first so the editor can show what the run will cost.
        let preview = null;
        try {
            preview = await api.quote(model.model, buildInput(model, { prompt: PRICE_CHECK_PROMPT, image, reference, options }));
            enforceLimit(preview);
        } catch (error) {
            if (!(error instanceof SpicyApiError)) throw error;
            if (error.kind !== 'api') throw error;
            preview = null;
        }
        const composed = await composePrompt({ kind, model, initial: prompt, autoWrite: !prompt, preview });
        if (composed === null) throw new Cancelled();
        prompt = composed.trim();
        if (!prompt) throw new Error('The prompt is empty.');
        shownWorst = preview ? worstCase(preview) : null;
    } else if (!prompt) {
        const progress = startProgress('Writing a prompt from the scene...', () => {});
        progress.stopLinkHidden();
        try {
            prompt = await writePrompt(kind);
        } finally {
            progress.close();
        }
    }

    // 2. The exact quote, the limit and, when needed, a confirmation.
    let input = buildInput(model, { prompt, image, reference, options });
    let quote = await api.quote(model.model, input);
    enforceLimit(quote);
    const alreadyShown = shownWorst !== null && worstCase(quote) <= shownWorst;
    if (job.auto) {
        await gateAutoRun(model, quote, prompt, job.autoHold);
    } else if (overConfirmAmount(quote) && !alreadyShown) {
        await confirmSpend(model, quote);
    }

    // 3. Submit. A changed or expired quote is re-priced and resent under the same key, so a task
    // the server did accept is recovered rather than created twice. The submission itself is not
    // cut short by "Stop waiting": stopping takes effect once the task id is known, so the toast
    // can say which task keeps running.
    const abort = new AbortController();
    const label = model.displayName || model.model;
    const progress = startProgress(`Starting ${label}...`, () => abort.abort(new SpicyApiError('stopped', { kind: 'aborted' })));
    const started = Date.now();
    let taskId = '';
    let delivering = false;
    let charged = false;
    const noteCharge = amount => {
        if (charged) return;
        charged = true;
        job.onCharge?.(Number(amount) || 0);
    };
    try {
        const idempotencyKey = newIdempotencyKey();
        let accepted;
        try {
            accepted = await api.createTask(model.model, input, {
                idempotencyKey,
                quoteId: quote.quoteId,
                expectedCost: quote.estimatedCost,
                waitSeconds: CREATE_WAIT_SECONDS,
            });
        } catch (error) {
            if (!(error instanceof SpicyApiError) || error.code !== 40901) throw error;
            const fresh = await api.quote(model.model, input);
            enforceLimit(fresh);
            if (job.auto) {
                if (worstCase(fresh) > worstCase(quote)) await gateAutoRun(model, fresh, prompt, job.autoHold);
            } else if (worstCase(fresh) > worstCase(quote) && overConfirmAmount(fresh)) {
                await confirmSpend(model, fresh);
            }
            quote = fresh;
            accepted = await api.createTask(model.model, input, {
                idempotencyKey,
                quoteId: quote.quoteId,
                expectedCost: quote.estimatedCost,
                waitSeconds: CREATE_WAIT_SECONDS,
            });
        }
        taskId = String(accepted?.taskId || '');
        if (abort.signal.aborted && !TERMINAL_STATES.has(accepted?.state)) throw abort.signal.reason;
        const timeoutMs = ((Number(model.taskTimeoutSeconds) || 3600) + 300) * 1000;
        const task = await api.waitForTask(taskId, {
            initial: accepted,
            timeoutMs,
            signal: abort.signal,
            onUpdate: record => {
                const state = record.state === 'queued' ? 'Queued' : record.state === 'running' ? 'Generating' : 'Finishing';
                progress.update(`${state}: ${label}, ${Math.round((Date.now() - started) / 1000)}s. Estimated ${formatUsd(quote.estimatedCost)}.`);
            },
        });
        recordSpend(task);
        noteCharge(usdToNumber(task.cost) ?? 0);
        if (task.state !== 'succeeded') throw new SpicyTaskError(task);
        progress.stopLinkHidden();
        progress.update(`Saving the ${KIND_NOUN[kind]}...`);
        delivering = true;
        return await deliver(task, {
            prompt,
            model,
            quiet: Boolean(job.quiet),
            appendTo: job.appendTo,
            waitForIdle: Boolean(job.waitForIdle),
            chatIdAtStart,
        });
    } catch (error) {
        // Submitted but the outcome is unknown (stopped waiting, timed out): count the estimate.
        if (taskId && !charged) noteCharge(usdToNumber(quote.estimatedCost) ?? worstCase(quote));
        if (error instanceof SpicyApiError && error.kind === 'aborted' && taskId) {
            toastr.info(
                `Stopped waiting. Task ${taskId} keeps running on SpicyAPI and is billed if it succeeds. Insert it later with /spicy-task ${taskId}`,
                'SpicyAPI',
                { timeOut: 30000, extendedTimeOut: 30000, escapeHtml: true },
            );
            throw new Cancelled('Stopped waiting.');
        }
        if (taskId && !delivering && !(error instanceof SpicyTaskError) && error instanceof SpicyApiError) {
            error.message = `${error.message} The task (${taskId}) may still finish; insert it later with /spicy-task ${taskId}.`;
        }
        throw error;
    } finally {
        progress.close();
        refreshBalanceQuietly();
    }
}

function recordSpend(task) {
    const cost = usdToNumber(task?.cost);
    if (cost && (task.settled || task.state === 'succeeded')) {
        session.spent += cost;
        session.runs += 1;
        renderSessionSpend();
    }
}

/**
 * Downloads every output file of a finished task, saves it in SillyTavern and attaches it to the
 * chat. Returns the local path of the first file.
 */
async function deliver(task, { prompt, model, quiet, appendTo, waitForIdle = false, chatIdAtStart }) {
    const api = client();
    const context = ctx();
    const assets = outputAssets(task).filter(asset => asset.url && !asset.unavailable);
    const wanted = assets.filter(asset => /^(image|video)\//.test(String(asset.mime || '')));
    const files = wanted.length ? wanted : assets;
    if (!files.length) throw new Error(`Task ${task.taskId} finished without a file to show.`);

    const saved = [];
    for (const [index, asset] of files.entries()) {
        let blob;
        try {
            blob = withMime(await api.download(asset.url), asset.mime);
        } catch (error) {
            throw new Error(`The result of task ${task.taskId} is ready, but it could not be downloaded: ${describeError(error)} Try again with /spicy-task ${task.taskId} (results are kept for a limited time).`);
        }
        const path = await saveToSillyTavern(blob, {
            folder: folderName(),
            filename: `spicyapi_${task.taskId}${files.length > 1 ? `_${index + 1}` : ''}`,
            headers: context.getRequestHeaders(),
        });
        saved.push({ path, type: mediaTypeForMime(blob.type || asset.mime) });
    }

    if (quiet) return saved[0].path;

    if (waitForIdle) await untilNotGenerating();

    if (chatIdAtStart && ctx().getCurrentChatId?.() !== chatIdAtStart) {
        toastr.warning(`The chat changed while this was generating, so it was not added to a chat. It is saved as ${saved[0].path}.`, 'SpicyAPI', { timeOut: 30000, escapeHtml: true });
        return saved[0].path;
    }

    const attachments = saved.map(file => ({
        url: file.path,
        type: file.type,
        title: prompt,
        source: 'generated',
    }));
    const note = { model: model.model, taskId: task.taskId, cost: task.cost };

    if (Number.isInteger(appendTo) && ctx().chat?.[appendTo]) {
        await appendToMessage(appendTo, attachments, note);
    } else {
        await postMessage(prompt, attachments, note);
    }
    toastr.success(`Done. ${task.settled ? 'Charged' : 'Held'} ${formatUsd(task.cost)}.`, 'SpicyAPI', { timeOut: 5000 });
    return saved[0].path;
}

function isGenerating() {
    const stop = document.getElementById('mes_stop');
    return Boolean(stop) && getComputedStyle(stop).display !== 'none';
}

/**
 * Waits while SillyTavern is generating a reply, so a new message is not pushed into the chat
 * under a reply that is still being written. Gives up after ten minutes.
 */
async function untilNotGenerating() {
    const deadline = Date.now() + 10 * 60_000;
    while (isGenerating() && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 500));
    }
}

async function postMessage(prompt, attachments, note) {
    const context = ctx();
    const message = {
        name: speakerName(),
        is_user: false,
        is_system: !settings().visibleToAi,
        send_date: new Date().toISOString(),
        mes: prompt,
        extra: {
            media: attachments,
            media_display: 'gallery',
            media_index: 0,
            inline_image: false,
            spicyapi: note,
        },
    };
    context.chat.push(message);
    const messageId = context.chat.length - 1;
    await context.eventSource.emit(context.eventTypes.MESSAGE_RECEIVED, messageId, 'extension');
    context.addOneMessage(message);
    await context.eventSource.emit(context.eventTypes.CHARACTER_MESSAGE_RENDERED, messageId, 'extension');
    await context.saveChat();
    setTimeout(() => context.scrollOnMediaLoad?.(), 100);
}

async function appendToMessage(messageId, attachments, note) {
    const context = ctx();
    const message = context.chat[messageId];
    message.extra = message.extra && typeof message.extra === 'object' ? message.extra : {};
    context.ensureMessageMediaIsArray?.(message);
    if (!Array.isArray(message.extra.media)) message.extra.media = [];
    if (!message.extra.media.length && !message.extra.media_display) message.extra.media_display = 'gallery';
    // A message that already shows media as a gallery keeps doing so.
    message.extra.inline_image = !(message.extra.media.length && !message.extra.inline_image);
    message.extra.media.push(...attachments);
    message.extra.media_index = message.extra.media.length - 1;
    message.extra.spicyapi = note;
    const element = $(`#chat .mes[mesid="${messageId}"]`);
    if (element.length) context.appendMediaToMessage(message, element);
    await context.saveChat();
}

/** Inserts the result of an existing task (after "Stop waiting", a timeout or a reload). */
async function insertTask(taskId, { quiet = false } = {}) {
    const api = client();
    const progress = startProgress(`Checking task ${taskId}...`, () => {});
    progress.stopLinkHidden();
    try {
        const task = await api.waitForTask(taskId, {
            timeoutMs: 30 * 60_000,
            onUpdate: record => progress.update(`Task ${taskId}: ${record.state}`),
        });
        if (task.state !== 'succeeded') throw new SpicyTaskError(task);
        if (task.contentState && task.contentState !== 'present') {
            throw new Error(`The files of task ${taskId} are no longer stored (${task.contentState}).`);
        }
        await loadCatalog().catch(() => []);
        const model = findModel(task.model) || { model: task.model, displayName: task.model };
        const prompt = typeof task.input?.prompt === 'string' ? task.input.prompt : `SpicyAPI task ${taskId}`;
        return await deliver(task, { prompt, model, quiet, chatIdAtStart: ctx().getCurrentChatId?.() });
    } finally {
        progress.close();
    }
}

/** Runs a job from a button or menu, reporting errors as toasts. */
async function runFromUi(job) {
    try {
        return await generate(job);
    } catch (error) {
        if (!(error instanceof Cancelled)) showError(error);
        return '';
    }
}

// -- Pictures the AI asks for ---------------------------------------------------

const TOOL_DESCRIPTION = [
    'Shows the user a picture of the current moment in the story, made by an image model from your description.',
    'Call it when a picture would add to the scene, for example when a new place or character appears, or when the user asks to see something.',
    'Do not call it on every reply. After it returns, continue the story as usual.',
].join(' ');

const TOOL_PROMPT_DESCRIPTION = 'A description of the picture for the image model: who is in the frame and how they look (describe them, do not only name them), what they are doing, the setting, the lighting and the camera framing. Concrete visual words, no dialogue, under 90 words.';

// Replies whose tags were removed and that must be drawn again once rendered.
const rerenderAfterTags = new WeakSet();

function autoEnabled(source) {
    const s = settings();
    if (!s.autoPictures) return false;
    return source === 'tool' ? Boolean(s.autoTool) : Boolean(s.autoTag);
}

/** This chat's automatic picture state, kept in the chat's metadata. */
function chatAutoState() {
    const metadata = ctx().chatMetadata;
    if (!metadata || typeof metadata !== 'object') return null;
    if (!metadata[MODULE] || typeof metadata[MODULE] !== 'object') metadata[MODULE] = {};
    return metadata[MODULE];
}

/**
 * Makes a picture the AI asked for. Never throws.
 * @param {{prompt: string, source: 'tool'|'tag'}} request
 * @returns {Promise<{shown: boolean, reason?: string}>}
 */
async function runAutoPicture({ prompt, source }) {
    const s = settings();
    if (!autoEnabled(source)) return { shown: false, reason: 'automatic pictures are turned off' };
    if (!s.apiKey) {
        toastr.warning('The AI asked for a picture, but there is no SpicyAPI key in Extensions > SpicyAPI.', 'SpicyAPI');
        return { shown: false, reason: 'the picture service is not set up' };
    }
    const context = ctx();
    if (!context.getCurrentChatId?.()) return { shown: false, reason: 'no chat is open' };

    // 1. Per-chat cooldown.
    const state = chatAutoState();
    const replies = countReplies(context.chat);
    const every = parseEvery(s.autoEvery);
    if (state && !cooldownAllows({ replies, lastReplies: state.autoReplies, every })) {
        console.info(LOG_PREFIX, `Automatic picture skipped: at most one every ${every} replies.`);
        return { shown: false, reason: `a picture was shown recently (at most one every ${every} replies)` };
    }

    // 2. Daily cap, before asking for a quote.
    const cap = parseLimit(s.autoDailyCap);
    if (cap !== null && autoSpend.spentToday() + autoReserved >= cap - 1e-9) {
        toastr.info(`Automatic picture skipped: today's limit for automatic pictures (${formatUsd(String(cap))}) is reached.`, 'SpicyAPI', { timeOut: 8000 });
        return { shown: false, reason: 'today\'s limit for automatic pictures is reached' };
    }

    // The attempt counts for the cooldown whatever happens next, so a refused or failed picture
    // is not asked for again on the very next reply.
    if (state) {
        state.autoReplies = replies;
        context.saveMetadataDebounced?.();
    }

    const autoHold = { amount: 0 };
    try {
        const path = await generate({
            kind: 'image',
            prompt,
            auto: true,
            autoHold,
            // The tool runs inside SillyTavern's generation and posts at once, as its own
            // message before the model continues. A tag is read from a finished reply; its
            // picture waits until no other reply is being written.
            waitForIdle: source === 'tag',
            onCharge: amount => {
                autoSpend.add(amount);
                renderAutoSpend();
            },
        });
        return path ? { shown: true } : { shown: false, reason: 'it could not be generated' };
    } catch (error) {
        if (error instanceof Skipped) {
            if (error.notify) toastr.info(`Automatic picture skipped: ${error.reason}.`, 'SpicyAPI', { timeOut: 8000, escapeHtml: true });
            return { shown: false, reason: error.reason };
        }
        if (error instanceof Cancelled) return { shown: false, reason: 'the user stopped it' };
        showError(error);
        if (error instanceof OverLimit) return { shown: false, reason: 'it costs more than the user allows per picture' };
        return { shown: false, reason: 'it could not be generated' };
    } finally {
        releaseAutoSpend(autoHold);
    }
}

function cleanToolPrompt(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 2000);
}

async function toolAction(args) {
    const prompt = cleanToolPrompt(args?.prompt);
    const outcome = prompt
        ? await runAutoPicture({ prompt, source: 'tool' })
        : { shown: false, reason: 'the description was empty' };
    if (outcome.shown) {
        return `Done: the picture is now shown to the user in the chat. Continue the story; do not describe the picture again and do not call ${TOOL_NAME} again in this reply.`;
    }
    return `No picture was shown because ${outcome.reason}. Continue the story without it and do not call ${TOOL_NAME} again in this reply.`;
}

/**
 * Registers the function tool once. SillyTavern asks `shouldRegister` before every chat request,
 * so switching it on or off takes effect immediately. The tool is offered on every request while it
 * is on; the cooldown and the daily cap are applied when it is called.
 */
function registerPictureTool() {
    const context = ctx();
    if (typeof context.registerFunctionTool !== 'function') {
        console.warn(LOG_PREFIX, 'This SillyTavern version has no function tools; the AI can use the reply tag instead.');
        return;
    }
    context.registerFunctionTool({
        name: TOOL_NAME,
        displayName: 'SpicyAPI picture',
        description: TOOL_DESCRIPTION,
        parameters: {
            type: 'object',
            properties: {
                prompt: { type: 'string', description: TOOL_PROMPT_DESCRIPTION },
            },
            required: ['prompt'],
        },
        action: toolAction,
        formatMessage: () => 'The AI asked SpicyAPI for a picture.',
        shouldRegister: () => autoEnabled('tool') && Boolean(settings().apiKey),
    });
}

/** Whether SillyTavern will offer function tools with the current chat connection. */
function toolCallingState() {
    const context = ctx();
    if (context.mainApi !== 'openai') return 'not-chat-completion';
    if (!context.chatCompletionSettings?.function_calling) return 'off';
    try {
        if (typeof context.isToolCallingSupported === 'function' && !context.isToolCallingSupported()) return 'unsupported';
    } catch {
        return 'unsupported';
    }
    return 'ready';
}

/** Puts the tag instruction into the prompt of normal generations when the user wants it. */
function onGenerationStarted(type) {
    const s = settings();
    const wanted = s.autoPictures && s.autoTag && s.autoTagInject && Boolean(s.apiKey) && type !== 'quiet' && type !== 'impersonate';
    ctx().setExtensionPrompt?.(INSTRUCTION_KEY, wanted ? tagInstruction(s.autoTagName) : '', PROMPT_IN_CHAT, INSTRUCTION_DEPTH, false, PROMPT_ROLE_SYSTEM);
}

/**
 * Removes picture tags from a new reply and makes the first one. The tag is taken out of the
 * stored message (and its swipe), so it neither shows nor goes back to the AI. The picture is
 * posted as its own message after the reply, like every other result, so it follows the
 * "Let the AI see generated pictures" setting instead of being sent along with the reply.
 */
function onMessageReceived(messageId, type) {
    if (!autoEnabled('tag') || NO_AUTO_TYPES.has(type)) return;
    const context = ctx();
    const message = context.chat?.[messageId];
    if (!message || message.is_user || message.is_system || message.extra?.spicyapi) return;
    const tagName = normalizeTagName(settings().autoTagName);
    const stripped = stripPictureTags(message.mes, tagName);
    if (!stripped.changed) return;
    message.mes = stripped.text;
    if (Array.isArray(message.swipes) && Number.isInteger(message.swipe_id) && message.swipe_id < message.swipes.length) {
        message.swipes[message.swipe_id] = stripped.text;
    }
    if (typeof message.extra?.display_text === 'string') {
        message.extra.display_text = stripPictureTags(message.extra.display_text, tagName).text;
    }
    rerenderAfterTags.add(message);
    // Streamed replies are already on screen; others are drawn right after this event.
    if ($(`#chat .mes[mesid="${messageId}"]`).length) context.updateMessageBlock?.(messageId, message);
    if (stripped.prompts.length) {
        runAutoPicture({ prompt: stripped.prompts[0], source: 'tag' });
    }
}

function onMessageRendered(messageId) {
    const context = ctx();
    const message = context.chat?.[messageId];
    if (!message || !rerenderAfterTags.has(message)) return;
    rerenderAfterTags.delete(message);
    context.updateMessageBlock?.(messageId, message);
}

// -- Settings panel ----------------------------------------------------------

async function renderSettings() {
    const response = await fetch(new URL('./settings.html', import.meta.url));
    const html = await response.text();
    $('#extensions_settings2').append(html);
    const s = settings();

    $('#spicyapi_key').val(s.apiKey).on('input', function () {
        settings().apiKey = String($(this).val() || '').trim();
        save();
        catalog.loaded = false;
    }).on('change', () => {
        refreshCatalogUi();
        refreshBalance();
    });
    $('#spicyapi_key_toggle').on('click', function () {
        const input = $('#spicyapi_key');
        const hidden = input.attr('type') === 'password';
        input.attr('type', hidden ? 'text' : 'password');
        $(this).toggleClass('fa-eye', !hidden).toggleClass('fa-eye-slash', hidden);
    });
    $('#spicyapi_transport').val(s.transport).on('change', function () {
        settings().transport = String($(this).val());
        save();
    });
    $('#spicyapi_base_url').val(s.baseUrl === DEFAULT_BASE_URL ? '' : s.baseUrl).on('change', function () {
        const value = String($(this).val() || '').trim();
        settings().baseUrl = value ? normalizeBaseUrl(value) : DEFAULT_BASE_URL;
        save();
        catalog.loaded = false;
        refreshCatalogUi();
    });
    $('#spicyapi_check').on('click', () => refreshBalance({ announce: true }));
    $('#spicyapi_refresh_models').on('click', () => refreshCatalogUi({ force: true }));

    $('#spicyapi_use_avatar').prop('checked', s.useAvatar).on('change', function () {
        settings().useAvatar = $(this).prop('checked');
        save();
    });
    $('#spicyapi_review').prop('checked', s.reviewPrompts).on('change', function () {
        settings().reviewPrompts = $(this).prop('checked');
        save();
    });
    $('#spicyapi_visible').prop('checked', s.visibleToAi).on('change', function () {
        settings().visibleToAi = $(this).prop('checked');
        save();
    });
    $('#spicyapi_confirm_above').val(s.confirmAbove ?? '').on('change', function () {
        settings().confirmAbove = parseLimit($(this).val());
        $(this).val(settings().confirmAbove ?? '');
        save();
    });
    $('#spicyapi_max_per_run').val(s.maxPerRun ?? '').on('change', function () {
        settings().maxPerRun = parseLimit($(this).val());
        $(this).val(settings().maxPerRun ?? '');
        save();
    });

    for (const kind of ['image', 't2v', 'i2v', 'chat']) {
        $(`#spicyapi_model_${kind}`).on('change', function () {
            settings()[SETTING_KEY_BY_KIND[kind]] = String($(this).val() || '');
            save();
            renderModelDetails(kind);
        });
    }
    $('#spicyapi_connect_chat').on('click', connectChat);

    bindAutoSettings();
    renderSessionSpend();
    if (s.apiKey) {
        refreshCatalogUi();
        refreshBalance();
    } else {
        $('#spicyapi_models_status').text('Paste an API key to load the models.');
    }
}

function bindAutoSettings() {
    const s = settings();
    const toggle = (selector, key) => {
        $(selector).prop('checked', Boolean(s[key])).on('change', function () {
            settings()[key] = $(this).prop('checked');
            save();
            renderAutoSettings();
        });
    };
    toggle('#spicyapi_auto', 'autoPictures');
    toggle('#spicyapi_auto_tool', 'autoTool');
    toggle('#spicyapi_auto_tag', 'autoTag');
    toggle('#spicyapi_tag_inject', 'autoTagInject');
    $('#spicyapi_tag_name').val(s.autoTagName === DEFAULT_TAG ? '' : s.autoTagName).on('change', function () {
        settings().autoTagName = normalizeTagName($(this).val());
        $(this).val(settings().autoTagName === DEFAULT_TAG ? '' : settings().autoTagName);
        save();
        renderAutoSettings();
    });
    $('#spicyapi_tag_copy').on('click', async () => {
        const text = tagInstruction(settings().autoTagName);
        try {
            await navigator.clipboard.writeText(text);
            toastr.success('Instruction copied.', 'SpicyAPI', { timeOut: 2000 });
        } catch {
            $('#spicyapi_tag_instruction').trigger('focus').trigger('select');
            toastr.info('Select the text and copy it with Ctrl+C.', 'SpicyAPI');
        }
    });
    $('#spicyapi_auto_every').val(parseEvery(s.autoEvery)).on('change', function () {
        settings().autoEvery = parseEvery($(this).val());
        $(this).val(settings().autoEvery);
        save();
    });
    $('#spicyapi_auto_cap').val(s.autoDailyCap ?? '').on('change', function () {
        settings().autoDailyCap = parseLimit($(this).val());
        $(this).val(settings().autoDailyCap ?? '');
        save();
        renderAutoSpend();
    });
    $('#spicyapi_auto_above').val(s.autoAboveConfirm === 'skip' ? 'skip' : 'ask').on('change', function () {
        settings().autoAboveConfirm = $(this).val() === 'skip' ? 'skip' : 'ask';
        save();
    });
    $('#spicyapi_enable_tools').on('click', () => {
        const box = $('#openai_function_calling');
        if (!box.length) {
            toastr.warning('Open AI Response Configuration and turn on Enable function calling.', 'SpicyAPI');
            return;
        }
        box.prop('checked', true).trigger('input');
        setTimeout(renderToolStatus, 0);
    });
    renderAutoSettings();
}

function renderAutoSettings() {
    const s = settings();
    $('#spicyapi_auto_options').toggle(Boolean(s.autoPictures));
    $('#spicyapi_tag_name, #spicyapi_tag_inject, #spicyapi_tag_instruction').prop('disabled', !s.autoTag);
    $('#spicyapi_tag_instruction').val(tagInstruction(s.autoTagName));
    renderToolStatus();
    renderAutoSpend();
}

function renderToolStatus() {
    const target = $('#spicyapi_tool_status');
    if (!target.length) return;
    const s = settings();
    const state = toolCallingState();
    const messages = {
        'not-chat-completion': 'Function tools need a Chat Completion API. With other APIs, use the reply tag below.',
        off: 'SillyTavern sends function tools only with Enable function calling turned on (AI Response Configuration).',
        unsupported: 'The connected chat model or prompt post-processing setting does not allow function tools. Use the reply tag below, or change the connection.',
        ready: 'Ready: the connected chat model can ask for a picture.',
    };
    target.text(s.autoTool ? messages[state] : 'Off.');
    $('#spicyapi_enable_tools').toggle(Boolean(s.autoTool) && state === 'off');
}

function renderAutoSpend() {
    const target = $('#spicyapi_auto_spent');
    if (!target.length) return;
    const cap = parseLimit(settings().autoDailyCap);
    const spent = autoSpend.spentToday();
    target.text(`Automatic pictures today, in this browser: ${formatUsd(spent.toFixed(6))}${cap === null ? '' : ` of ${formatUsd(String(cap))}`}.`);
}

function fillModelSelect(kind) {
    const select = $(`#spicyapi_model_${kind}`);
    if (!select.length) return;
    const saved = settings()[SETTING_KEY_BY_KIND[kind]];
    select.empty();
    if (kind === 'chat') {
        select.append($('<option>').val('').text('Keep the model chosen in SillyTavern'));
    } else {
        const automatic = automaticModel(catalog.items, kind);
        select.append($('<option>').val('').text(automatic ? `Automatic: ${modelLabel(automatic)}` : 'Automatic'));
    }
    for (const group of groupedModels(catalog.items, kind)) {
        const optgroup = $('<optgroup>').attr('label', group.label);
        for (const model of group.models) {
            optgroup.append($('<option>').val(model.model).text(kind === 'chat' ? (model.displayName || model.model) : modelLabel(model)));
        }
        select.append(optgroup);
    }
    if (saved && !findModel(saved)) {
        select.append($('<option>').val(saved).text(`${saved} (not available)`));
    }
    select.val(saved || '');
}

function renderModelDetails(kind) {
    const container = $(`#spicyapi_details_${kind}`);
    if (!container.length) return;
    container.empty();
    const id = settings()[SETTING_KEY_BY_KIND[kind]];
    const model = id ? findModel(id) : automaticModel(catalog.items, kind);
    if (!model) return;

    const table = priceTable(model);
    if (table.length) {
        const details = $('<details class="spicyapi-prices">');
        details.append($('<summary>').text(`Price: ${describeStartingPrice(model)}`));
        const list = $('<ul>');
        for (const row of table) {
            list.append($('<li>').text(`${row.label}: ${row.price}`));
        }
        details.append(list);
        container.append(details);
    }

    const saved = settings().modelOptions[model.model] || {};
    for (const field of optionFields(model)) {
        const id = `spicyapi_opt_${kind}_${field.name}`;
        const row = $('<div class="spicyapi-option">');
        const title = field.description || field.label;
        const label = $('<label>').attr('for', id).attr('title', title).text(field.label);
        if (field.affectsPrice) label.append(' ', $('<small class="spicyapi-price-tag">').attr('title', 'Changes the price').text('$'));
        row.append(label);
        const current = validOptionValue(field, saved[field.name]);
        let control;
        if (field.kind === 'enum') {
            control = $('<select class="text_pole">').attr('id', id);
            control.append($('<option>').val('').text(field.default !== undefined ? `Default (${field.default})` : 'Default'));
            for (const option of field.options) control.append($('<option>').val(String(option)).text(String(option)));
            control.val(current === undefined ? '' : String(current));
        } else if (field.kind === 'bool') {
            control = $('<select class="text_pole">').attr('id', id);
            const fallback = field.default === undefined ? '' : ` (${field.default ? 'on' : 'off'})`;
            control.append($('<option>').val('').text(`Default${fallback}`));
            control.append($('<option>').val('true').text('On'));
            control.append($('<option>').val('false').text('Off'));
            control.val(current === undefined ? '' : String(current));
        } else {
            control = $('<input type="number" class="text_pole">').attr({ id, min: field.min, max: field.max, step: field.step || 1 });
            control.attr('placeholder', field.default !== undefined ? `Default (${field.default})` : `${field.min} to ${field.max}`);
            control.val(current === undefined ? '' : String(current));
        }
        control.on('change', function () {
            const store = settings().modelOptions;
            const entry = store[model.model] || {};
            const value = validOptionValue(field, $(this).val());
            if (value === undefined) delete entry[field.name];
            else entry[field.name] = value;
            if (Object.keys(entry).length) store[model.model] = entry;
            else delete store[model.model];
            if (field.kind === 'int') $(this).val(value === undefined ? '' : String(value));
            save();
        });
        row.append(control);
        container.append(row);
    }
    if (kind === 'image') {
        const note = requiresImage(model)
            ? 'This model edits a picture: it always uses the character avatar.'
            : (acceptsReference(model) ? 'This model can take the character avatar as a reference.' : 'This model does not take a reference picture.');
        container.append($('<small class="spicyapi-note">').text(note));
    }
}

async function refreshCatalogUi({ force = false } = {}) {
    const status = $('#spicyapi_models_status');
    if (!settings().apiKey) {
        status.text('Paste an API key to load the models.');
        return;
    }
    status.text('Loading models...');
    try {
        await loadCatalog({ force });
        for (const kind of ['image', 't2v', 'i2v', 'chat']) {
            fillModelSelect(kind);
            renderModelDetails(kind);
        }
        const count = catalog.items.length;
        status.text(`${count} models loaded.`);
    } catch (error) {
        status.text(describeError(error));
    }
}

async function refreshBalance({ announce = false } = {}) {
    const target = $('#spicyapi_balance');
    if (!settings().apiKey) {
        target.text('No API key.');
        return;
    }
    target.text('Checking...');
    const api = client();
    try {
        const balance = await api.balance();
        const held = usdToNumber(balance.held);
        target.text(`Balance ${formatBalance(balance.available)}${held ? `, ${formatBalance(balance.held)} held` : ''}`);
        if (announce) {
            const route = api.lastRoute === 'proxy' ? 'through SillyTavern\'s proxy' : 'directly from the browser';
            toastr.success(`Connected ${route}. Balance ${formatBalance(balance.available)}.`, 'SpicyAPI');
            if (!catalog.loaded) refreshCatalogUi();
        }
    } catch (error) {
        target.text('Not connected.');
        if (announce) showError(error);
    }
}

function refreshBalanceQuietly() {
    if ($('#spicyapi_balance').length) refreshBalance().catch(() => {});
}

function renderSessionSpend() {
    const target = $('#spicyapi_session_spend');
    if (!target.length) return;
    target.text(session.runs
        ? `This session: ${formatUsd(session.spent.toFixed(6))} across ${session.runs} generation${session.runs === 1 ? '' : 's'}.`
        : 'Nothing spent in this session yet.');
}

// -- Chat connection -----------------------------------------------------------

async function writeCustomKey(key) {
    const s = settings();
    // Replace the key this extension stored last time instead of piling up copies.
    let secrets = null;
    try {
        secrets = await import('/scripts/secrets.js');
    } catch {
        secrets = null;
    }
    const secretKey = secrets?.SECRET_KEYS?.CUSTOM || 'api_key_custom';
    if (s.chatSecretId) {
        try {
            if (secrets?.deleteSecret) await secrets.deleteSecret(secretKey, s.chatSecretId);
            else await fetch('/api/secrets/delete', { method: 'POST', headers: ctx().getRequestHeaders(), body: JSON.stringify({ key: secretKey, id: s.chatSecretId }) });
        } catch {
            // It may already be gone; a new one is written below either way.
        }
    }
    let id = null;
    if (secrets?.writeSecret) {
        id = await secrets.writeSecret(secretKey, key, 'SpicyAPI');
    } else {
        const response = await fetch('/api/secrets/write', {
            method: 'POST',
            headers: ctx().getRequestHeaders(),
            body: JSON.stringify({ key: secretKey, value: key, label: 'SpicyAPI' }),
        });
        id = response.ok ? (await response.json()).id : null;
    }
    if (!id) throw new Error('SillyTavern did not accept the key. See the manual steps in the README.');
    s.chatSecretId = id;
    save();
}

async function runSlash(command) {
    const context = ctx();
    const result = await context.executeSlashCommandsWithOptions(command, { handleParserErrors: true, handleExecutionErrors: true });
    if (result?.isError) throw new Error(result.errorMessage || `${command} failed.`);
    return result?.pipe;
}

async function connectChat() {
    const s = settings();
    if (!s.apiKey) {
        toastr.warning('Paste an API key first.', 'SpicyAPI');
        return;
    }
    const url = `${normalizeBaseUrl(s.baseUrl)}/v1`;
    try {
        await writeCustomKey(s.apiKey);
        await runSlash(`/api-url api=custom connect=false quiet=true ${url}`);
        await runSlash('/api quiet=true custom');
        if (s.chatModel) await runSlash(`/model quiet=true ${s.chatModel}`);
        $('#api_button_openai').trigger('click');
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline && ctx().onlineStatus === 'no_connection') {
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        if (ctx().onlineStatus === 'no_connection') {
            toastr.warning('The settings are in place, but SillyTavern has not connected yet. Open API Connections and press Connect.', 'SpicyAPI', { timeOut: 15000 });
        } else {
            toastr.success(`Chat now uses SpicyAPI${s.chatModel ? ` (${s.chatModel})` : ''}.`, 'SpicyAPI');
        }
    } catch (error) {
        showError(error);
    }
}

// -- Buttons and menus ------------------------------------------------------------

const ANIMATE_TITLE = 'Animate with SpicyAPI (image to video)';

function injectAnimateButtons() {
    const imageButton = `<div title="${ANIMATE_TITLE}" class="right_menu_button fa-lg fa-solid fa-film spicyapi_animate_image"></div>`;
    const messageButton = `<div title="${ANIMATE_TITLE}" class="mes_button fa-solid fa-film spicyapi_animate_message"></div>`;
    $('#message_image_template .mes_img_controls').each(function () {
        if (!$(this).find('.spicyapi_animate_image').length) $(this).prepend(imageButton);
    });
    $('#chat .mes_img_controls').each(function () {
        if (!$(this).find('.spicyapi_animate_image').length) $(this).prepend(imageButton);
    });
    $('#message_template .extraMesButtons').each(function () {
        if (!$(this).find('.spicyapi_animate_message').length) $(this).prepend(messageButton);
    });
    $('#chat .extraMesButtons').each(function () {
        if (!$(this).find('.spicyapi_animate_message').length) $(this).prepend(messageButton);
    });
}

async function animateFromButton(button, url, messageId) {
    if (!url) {
        toastr.warning('This message has no picture to animate.', 'SpicyAPI');
        return;
    }
    if (button.hasClass('spicyapi-busy')) {
        toastr.info('This picture is already being animated.', 'SpicyAPI');
        return;
    }
    button.addClass('spicyapi-busy fa-fade');
    try {
        await runFromUi({ kind: 'i2v', imageUrl: url, appendTo: messageId });
    } finally {
        button.removeClass('spicyapi-busy fa-fade');
    }
}

function bindButtons() {
    $(document).on('click', '.spicyapi_animate_image', function (event) {
        event.preventDefault();
        event.stopPropagation();
        const button = $(this);
        const messageId = Number(button.closest('.mes').attr('mesid'));
        const index = Number(button.closest('.mes_media_container').attr('data-index'));
        const message = ctx().chat?.[messageId];
        ctx().ensureMessageMediaIsArray?.(message);
        const url = message?.extra?.media?.[index]?.url || button.closest('.mes_img_container').find('.mes_img').attr('src');
        animateFromButton(button, url, messageId);
    });
    $(document).on('click', '.spicyapi_animate_message', function (event) {
        event.preventDefault();
        event.stopPropagation();
        const button = $(this);
        const messageId = Number(button.closest('.mes').attr('mesid'));
        animateFromButton(button, pictureOfMessage(ctx().chat?.[messageId]), messageId);
    });
}

function addWandMenu() {
    const menu = $('#extensionsMenu');
    if (!menu.length || $('#spicyapi_wand_container').length) return;
    const item = (id, icon, text, title) => `
        <div id="${id}" class="list-group-item flex-container flexGap5 interactable" tabindex="0" title="${title}">
            <div class="fa-solid ${icon} extensionsMenuExtensionButton"></div>
            <span>${text}</span>
        </div>`;
    const container = $(`<div id="spicyapi_wand_container" class="extension_container">
        ${item('spicyapi_wand_image', 'fa-image', 'SpicyAPI picture', 'Make a picture of the current scene with SpicyAPI')}
        ${item('spicyapi_wand_video', 'fa-video', 'SpicyAPI video', 'Make a short video of the current scene with SpicyAPI')}
        ${item('spicyapi_wand_animate', 'fa-film', 'SpicyAPI: animate last picture', 'Turn the most recent picture in this chat into a video')}
    </div>`);
    menu.append(container);
    $('#spicyapi_wand_image').on('click', () => runFromUi({ kind: 'image' }));
    $('#spicyapi_wand_video').on('click', () => runFromUi({ kind: 't2v' }));
    $('#spicyapi_wand_animate').on('click', () => {
        const picture = latestPicture();
        if (!picture) {
            toastr.warning('There is no picture in this chat yet.', 'SpicyAPI');
            return;
        }
        runFromUi({ kind: 'i2v', imageUrl: picture.url, appendTo: picture.messageId });
    });
}

// -- Slash commands -------------------------------------------------------------

function isTrue(value) {
    return ['true', 'on', 'yes', '1'].includes(String(value ?? '').trim().toLowerCase());
}

function isFalse(value) {
    return ['false', 'off', 'no', '0'].includes(String(value ?? '').trim().toLowerCase());
}

function modelEnum(kind) {
    const context = ctx();
    return () => catalog.items
        .filter(model => fitsKind(model, kind))
        .map(model => new context.SlashCommandEnumValue(model.model, model.displayName || null));
}

function registerCommands() {
    const context = ctx();
    const { SlashCommandParser, SlashCommand, SlashCommandNamedArgument, SlashCommandArgument, ARGUMENT_TYPE } = context;
    if (!SlashCommandParser?.addCommandObject) {
        console.warn(LOG_PREFIX, 'This SillyTavern version has no slash command API; commands are not registered.');
        return;
    }
    const quietArg = SlashCommandNamedArgument.fromProps({
        name: 'quiet',
        description: 'save the result and return its path without posting it to the chat',
        typeList: [ARGUMENT_TYPE.BOOLEAN],
        defaultValue: 'false',
    });
    const editArg = SlashCommandNamedArgument.fromProps({
        name: 'edit',
        description: 'open the prompt editor before generating',
        typeList: [ARGUMENT_TYPE.BOOLEAN],
        defaultValue: 'false',
    });
    const promptArg = SlashCommandArgument.fromProps({
        description: 'prompt; leave it out to let the connected chat model write one from the scene',
        typeList: [ARGUMENT_TYPE.STRING],
        isRequired: false,
    });

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'spicy-img',
        aliases: ['spicy-image'],
        returns: 'local path of the saved picture, or an empty string',
        callback: async (args, value) => {
            try {
                return await generate({
                    kind: 'image',
                    prompt: String(value ?? ''),
                    modelId: args.model ? String(args.model) : '',
                    quiet: isTrue(args.quiet),
                    edit: isTrue(args.edit),
                    useAvatar: isTrue(args.avatar) ? true : (isFalse(args.avatar) ? false : undefined),
                });
            } catch (error) {
                if (!(error instanceof Cancelled)) showError(error);
                return '';
            }
        },
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'model',
                description: 'model id (defaults to the picture model in the SpicyAPI settings)',
                typeList: [ARGUMENT_TYPE.STRING],
                enumProvider: modelEnum('image'),
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'avatar',
                description: 'use the character avatar as a reference picture when the model accepts one',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
            }),
            quietArg,
            editArg,
        ],
        unnamedArgumentList: [promptArg],
        helpString: `
            <div>Generates a picture with SpicyAPI and posts it to the chat (hidden from the AI unless the settings say otherwise).</div>
            <div>Without a prompt, the connected chat model writes one from the current scene. The price is shown before anything is charged.</div>
            <div><strong>Example:</strong> <pre><code>/spicy-img a lighthouse on a cliff at dusk, wide shot</code></pre></div>`,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'spicy-video',
        returns: 'local path of the saved video, or an empty string',
        callback: async (args, value) => {
            try {
                const image = String(args.image ?? '').trim();
                if (image) {
                    const picture = image.toLowerCase() === 'last' ? latestPicture() : { url: image };
                    if (!picture?.url) throw new Error('There is no picture in this chat to animate.');
                    return await generate({
                        kind: 'i2v',
                        prompt: String(value ?? ''),
                        imageUrl: picture.url,
                        modelId: args.model ? String(args.model) : '',
                        quiet: isTrue(args.quiet),
                        edit: isTrue(args.edit),
                    });
                }
                return await generate({
                    kind: 't2v',
                    prompt: String(value ?? ''),
                    modelId: args.model ? String(args.model) : '',
                    quiet: isTrue(args.quiet),
                    edit: isTrue(args.edit),
                });
            } catch (error) {
                if (!(error instanceof Cancelled)) showError(error);
                return '';
            }
        },
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'image',
                description: '"last" to animate the most recent picture in the chat, or a picture URL; leave it out for text to video',
                typeList: [ARGUMENT_TYPE.STRING],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'model',
                description: 'model id (defaults to the video models in the SpicyAPI settings)',
                typeList: [ARGUMENT_TYPE.STRING],
                enumProvider: () => [...modelEnum('t2v')(), ...modelEnum('i2v')()],
            }),
            quietArg,
            editArg,
        ],
        unnamedArgumentList: [promptArg],
        helpString: `
            <div>Generates a short video with SpicyAPI: from text, or from a picture with <code>image=last</code>.</div>
            <div>Without a prompt, the connected chat model writes one from the current scene. The price is shown before anything is charged.</div>
            <div><strong>Examples:</strong> <pre><code>/spicy-video waves rolling onto a beach at sunrise</code></pre> <pre><code>/spicy-video image=last slow push-in, hair moving in the wind</code></pre></div>`,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'spicy-task',
        returns: 'local path of the saved result, or an empty string',
        callback: async (args, value) => {
            const taskId = String(value ?? '').trim();
            if (!taskId) {
                toastr.warning('Give the task id, for example /spicy-task job_...', 'SpicyAPI');
                return '';
            }
            try {
                return await insertTask(taskId, { quiet: isTrue(args.quiet) });
            } catch (error) {
                showError(error);
                return '';
            }
        },
        namedArgumentList: [quietArg],
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'SpicyAPI task id', typeList: [ARGUMENT_TYPE.STRING], isRequired: true })],
        helpString: '<div>Waits for an existing SpicyAPI task and adds its result to the chat. Use it after "Stop waiting" or a page reload. Results are kept for a limited time.</div>',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'spicy-balance',
        returns: 'available SpicyAPI balance in USD',
        callback: async () => {
            try {
                const balance = await client().balance();
                return String(balance.available ?? '');
            } catch (error) {
                showError(error);
                return '';
            }
        },
        helpString: '<div>Returns the available SpicyAPI balance in USD.</div>',
    }));
}

// -- Start-up ---------------------------------------------------------------------

async function init() {
    settings();
    try {
        await renderSettings();
    } catch (error) {
        console.error(LOG_PREFIX, 'Could not render the settings panel', error);
    }
    addWandMenu();
    injectAnimateButtons();
    bindButtons();
    registerCommands();
    registerPictureTool();
    const context = ctx();
    const types = context.eventTypes;
    context.eventSource.on(types.GENERATION_STARTED, onGenerationStarted);
    context.eventSource.on(types.MESSAGE_RECEIVED, onMessageReceived);
    context.eventSource.on(types.CHARACTER_MESSAGE_RENDERED, onMessageRendered);
    for (const type of [types.MAIN_API_CHANGED, types.CHATCOMPLETION_SOURCE_CHANGED, types.CHATCOMPLETION_MODEL_CHANGED, types.SETTINGS_UPDATED, types.ONLINE_STATUS_CHANGED]) {
        if (type) context.eventSource.on(type, () => setTimeout(renderToolStatus, 0));
    }
    $(document).on('input change', '#openai_function_calling, #custom_prompt_post_processing', () => setTimeout(renderToolStatus, 0));
    // Messages rendered before this extension loaded have no Animate button yet.
    context.eventSource.on(context.eventTypes.CHAT_CHANGED, () => setTimeout(injectAnimateButtons, 0));
    context.eventSource.on(context.eventTypes.APP_READY, () => {
        addWandMenu();
        injectAnimateButtons();
    });
}

jQuery(async () => {
    try {
        await init();
    } catch (error) {
        console.error(LOG_PREFIX, 'Failed to start', error);
    }
});
