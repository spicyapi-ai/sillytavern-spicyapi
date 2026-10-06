/**
 * Pictures the AI asks for on its own: the reply tag parser, the per-chat cooldown and the daily
 * spending cap for automatic pictures. Everything here is plain logic with no SillyTavern or
 * browser dependency, so it can be tested under Node.
 */

export const DEFAULT_TAG = 'pic';
export const DEFAULT_EVERY = 3;
export const TOOL_NAME = 'spicyapi_generate_image';

const TAG_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const ENTITIES = { quot: '"', apos: '\'', amp: '&', lt: '<', gt: '>', nbsp: ' ' };

/** The tag name to look for: the configured one when it is a plain word, otherwise `pic`. */
export function normalizeTagName(value) {
    const name = String(value ?? '').trim().replace(/^<+|>+$/g, '').trim();
    return TAG_NAME.test(name) ? name : DEFAULT_TAG;
}

function decodeEntities(value) {
    return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
        if (entity[0] === '#') {
            const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
            return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : match;
        }
        return ENTITIES[entity.toLowerCase()] ?? match;
    });
}

function cleanPrompt(value) {
    return decodeEntities(String(value ?? '')).replace(/\s+/g, ' ').trim();
}

const QUOTES = { '"': '"', '\'': '\'', '“': '”', '‘': '’' };

/**
 * Reads the attributes of an opening tag, from just after the tag name to the closing `>`.
 * Quoted values may contain `>` and backslash-escaped quotes.
 * @returns {{attributes: Record<string,string>, end: number, selfClosing: boolean}|null}
 */
function readAttributes(text, from) {
    const attributes = {};
    let i = from;
    const length = text.length;
    for (;;) {
        while (i < length && /\s/.test(text[i])) i++;
        if (i >= length) return null;
        if (text[i] === '>') return { attributes, end: i + 1, selfClosing: false };
        if (text[i] === '/' && text[i + 1] === '>') return { attributes, end: i + 2, selfClosing: true };
        if (text[i] === '/') {
            i++;
            continue;
        }
        if (text[i] === '<') return null;
        const nameStart = i;
        while (i < length && /[^\s=>/<]/.test(text[i])) i++;
        const name = text.slice(nameStart, i).toLowerCase();
        if (!name) return null;
        while (i < length && /\s/.test(text[i])) i++;
        if (text[i] !== '=') {
            attributes[name] = '';
            continue;
        }
        i++;
        while (i < length && /\s/.test(text[i])) i++;
        const close = QUOTES[text[i]];
        if (close) {
            i++;
            let value = '';
            while (i < length && text[i] !== close) {
                if (text[i] === '\\' && (text[i + 1] === close || text[i + 1] === '\\')) {
                    value += text[i + 1];
                    i += 2;
                    continue;
                }
                value += text[i];
                i++;
            }
            if (i >= length) return null;
            i++;
            attributes[name] = value;
        } else {
            const valueStart = i;
            while (i < length && /[^\s>]/.test(text[i]) && !(text[i] === '/' && text[i + 1] === '>')) i++;
            attributes[name] = text.slice(valueStart, i);
        }
    }
}

/**
 * Finds picture tags in a reply. Accepted forms, with any letter case:
 * `<pic prompt="...">`, `<pic prompt='...' />`, `<pic prompt="..."></pic>` and `<pic>...</pic>`.
 * @param {string} text
 * @param {string} [tagName]
 * @returns {Array<{start: number, end: number, prompt: string}>} Tags in order; `prompt` may be empty.
 */
export function findPictureTags(text, tagName = DEFAULT_TAG) {
    const source = String(text ?? '');
    const name = normalizeTagName(tagName);
    const lower = source.toLowerCase();
    const opening = `<${name.toLowerCase()}`;
    const closing = new RegExp(`^\\s*<\\/\\s*${name}\\s*>`, 'i');
    const found = [];
    let index = 0;
    while ((index = lower.indexOf(opening, index)) !== -1) {
        const afterName = index + opening.length;
        const next = source[afterName];
        if (next !== undefined && !/[\s>/]/.test(next)) {
            index = afterName;
            continue;
        }
        const parsed = readAttributes(source, afterName);
        if (!parsed) {
            index = afterName;
            continue;
        }
        let end = parsed.end;
        let prompt = parsed.attributes.prompt ?? '';
        if (!parsed.selfClosing) {
            const rest = source.slice(end);
            const directClose = rest.match(closing);
            if (directClose) {
                end += directClose[0].length;
            } else if (!prompt) {
                // <pic>description</pic>: the description is the content.
                const contentClose = new RegExp(`<\\/\\s*${name}\\s*>`, 'i').exec(rest);
                if (contentClose && !rest.slice(0, contentClose.index).toLowerCase().includes(opening)) {
                    prompt = rest.slice(0, contentClose.index);
                    end += contentClose.index + contentClose[0].length;
                }
            }
        }
        found.push({ start: index, end, prompt: cleanPrompt(prompt) });
        index = end;
    }
    return found;
}

/**
 * Removes every picture tag from a reply and tidies the whitespace they leave behind.
 * @returns {{text: string, prompts: string[], changed: boolean}} The cleaned text and the
 * non-empty prompts in order.
 */
export function stripPictureTags(text, tagName = DEFAULT_TAG) {
    const source = String(text ?? '');
    const tags = findPictureTags(source, tagName);
    if (!tags.length) return { text: source, prompts: [], changed: false };
    let result = '';
    let last = 0;
    for (const tag of tags) {
        result += source.slice(last, tag.start);
        last = tag.end;
    }
    result += source.slice(last);
    // A closing tag left over from a tag that had its prompt in an attribute.
    result = result.replace(new RegExp(`<\\/\\s*${normalizeTagName(tagName)}\\s*>`, 'gi'), '');
    result = result
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n[ \t]+\n/g, '\n\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
    return { text: result, prompts: tags.map(tag => tag.prompt).filter(Boolean), changed: true };
}

/** The instruction that asks a chat model to use the reply tag. Neutral wording, no content. */
export function tagInstruction(tagName = DEFAULT_TAG) {
    const name = normalizeTagName(tagName);
    return [
        `You can show the user a picture of the current moment in the story.`,
        `When a picture would add to the scene, for example when a new place or character appears or the user asks to see something, end your reply with one tag in this form: <${name} prompt="description of the picture">.`,
        `In the description, say who is in the frame and how they look (describe them, do not only name them), what they are doing, the setting, the lighting and the camera framing, in under 60 words.`,
        `Use at most one tag per reply, do not add one to every reply, and do not mention the tag in the story.`,
    ].join(' ');
}

// -- Cooldown -------------------------------------------------------------------

function isOwnOrSystem(message) {
    return !message || message.is_system || Boolean(message.extra?.spicyapi);
}

/**
 * Counts the AI's replies in a chat, for the cooldown. Messages this extension posted, system
 * messages and hidden messages do not count. When the newest counted message is the user's, the
 * reply being written right now counts as well, so a picture asked for while the reply is still
 * being generated is attributed to that reply.
 * @param {any[]} chat
 */
export function countReplies(chat) {
    const messages = Array.isArray(chat) ? chat : [];
    let replies = 0;
    let lastIsUser = false;
    for (const message of messages) {
        if (isOwnOrSystem(message)) continue;
        if (message.is_user) {
            lastIsUser = true;
        } else {
            replies++;
            lastIsUser = false;
        }
    }
    return replies + (lastIsUser ? 1 : 0);
}

/** "At most one picture every N replies": N as a whole number of at least 1. */
export function parseEvery(value) {
    if (value === '' || value === null || value === undefined) return DEFAULT_EVERY;
    const number = Math.floor(Number(value));
    if (!Number.isFinite(number)) return DEFAULT_EVERY;
    return Math.min(1000, Math.max(1, number));
}

/**
 * Whether the cooldown lets an automatic picture through now.
 * @param {{replies: number, lastReplies?: number|null, every?: number}} state `replies` is the
 * current count, `lastReplies` the count when the last automatic picture was started.
 */
export function cooldownAllows({ replies, lastReplies, every = DEFAULT_EVERY }) {
    if (lastReplies === null || lastReplies === undefined || !Number.isFinite(Number(lastReplies))) return true;
    const since = Number(replies) - Number(lastReplies);
    // A shorter chat than before means messages were deleted: start counting again.
    if (since < 0) return true;
    return since >= parseEvery(every);
}

/** How many more replies until the cooldown allows a picture (0 when it does now). */
export function repliesUntilAllowed({ replies, lastReplies, every = DEFAULT_EVERY }) {
    if (cooldownAllows({ replies, lastReplies, every })) return 0;
    return parseEvery(every) - (Number(replies) - Number(lastReplies));
}

// -- Daily cap --------------------------------------------------------------------

/** The local calendar day, as YYYY-MM-DD. */
export function dayKey(date = new Date()) {
    const pad = value => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Amount spent on the given day according to a stored record (anything else counts as 0). */
export function spentOn(record, day) {
    if (!record || typeof record !== 'object' || record.day !== day) return 0;
    const spent = Number(record.spent);
    return Number.isFinite(spent) && spent > 0 ? spent : 0;
}

/** The record after spending `amount` on `day`; a new day starts from zero. */
export function addSpend(record, amount, day) {
    const value = Number(amount);
    const add = Number.isFinite(value) && value > 0 ? value : 0;
    // Round away floating point noise, keeping more precision than any price has.
    const spent = Math.round((spentOn(record, day) + add) * 1e9) / 1e9;
    return { day, spent };
}

/**
 * Whether a run that could cost `cost` fits under the daily cap. `cap` null means no cap.
 * @param {{spent: number, cost: number, cap: number|null}} state
 */
export function capAllows({ spent, cost, cap }) {
    if (cap === null || cap === undefined) return true;
    const limit = Number(cap);
    if (!Number.isFinite(limit)) return true;
    return Number(spent || 0) + Number(cost || 0) <= limit + 1e-9;
}

/**
 * Daily spending on automatic pictures, kept in browser storage (one record per browser).
 * Falls back to memory when storage is unavailable, for example in a private window.
 * @param {{getItem: Function, setItem: Function}|null} storage
 * @param {string} key
 * @param {() => Date} [now]
 */
export function createDailySpendStore(storage, key, now = () => new Date()) {
    let memory = null;
    const read = () => {
        try {
            const raw = storage?.getItem(key);
            if (raw) return JSON.parse(raw);
        } catch {
            // Unreadable storage: use what this page remembers.
        }
        return memory;
    };
    const write = record => {
        memory = record;
        try {
            storage?.setItem(key, JSON.stringify(record));
        } catch {
            // Storage is full or blocked: the record lives in memory for this page.
        }
    };
    return {
        spentToday() {
            return spentOn(read(), dayKey(now()));
        },
        add(amount) {
            const record = addSpend(read(), amount, dayKey(now()));
            write(record);
            return record.spent;
        },
    };
}
