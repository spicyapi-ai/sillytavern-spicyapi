/**
 * Everything the extension derives from the model catalogue: which models fit which job, how a
 * model's price reads, which of its settings are worth showing, and how a request body is built
 * from a prompt, an optional picture and the user's saved settings.
 *
 * Pure functions only, so they can be tested under Node.
 */

import { formatUsd, usdToNumber } from './client.js';

/** The jobs the extension does, and the catalogue tasks that serve each one. */
export const KINDS = Object.freeze({
    image: { modality: 'image', tasks: ['text-to-image', 'image-to-image'], label: 'Image' },
    t2v: { modality: 'video', tasks: ['text-to-video'], label: 'Text to video' },
    i2v: { modality: 'video', tasks: ['image-to-video'], label: 'Image to video' },
    chat: { modality: 'text', tasks: ['chat'], label: 'Chat' },
});

const UNIT_LABELS = {
    per_image: 'image',
    per_second: 'second',
    per_request: 'run',
    per_1k_characters: '1k characters',
    per_1k_tokens: '1k tokens',
};

export const POLICY_LABELS = {
    unrestricted: 'Uncensored',
    softened: 'Softened',
    filtered: 'Filtered',
};

const POLICY_ORDER = ['unrestricted', 'softened', 'filtered'];

// Settings that are not shown as model options: the prompt and media come from the chat, and the
// rest are either free-form or need more than a dropdown to fill in.
const NON_OPTION_FIELDS = new Set([
    'prompt', 'negative_prompt', 'seed', 'loras', 'high_noise_loras', 'low_noise_loras',
    'messages', 'multi_prompt', 'tools', 'stop',
]);

// Shown even when they do not change the price, because they change what comes back.
const COMMON_OPTION_FIELDS = new Set([
    'aspect_ratio', 'resolution', 'size', 'duration_seconds', 'generate_audio', 'quality', 'num_outputs',
]);

// Where a single picture goes, in order of preference. The first is the opening frame of an
// image-to-video model or the picture an edit model works on.
const PRIMARY_IMAGE_FIELDS = ['image_url', 'first_frame_url', 'start_image_url', 'first_image_url', 'image_urls'];
// Where a reference picture (the character avatar) goes on a model that only optionally takes one.
const REFERENCE_IMAGE_FIELDS = ['reference_image_urls', 'reference_image_url', 'image_urls', 'image_url'];

/** @param {any} model */
export function schemaOf(model) {
    const schema = model?.inputSchema;
    return schema && typeof schema === 'object' ? schema : { properties: {}, required: [] };
}

function propertiesOf(model) {
    const properties = schemaOf(model).properties;
    return properties && typeof properties === 'object' ? properties : {};
}

function requiredOf(model) {
    const required = schemaOf(model).required;
    return Array.isArray(required) ? required : [];
}

/** True when a schema property takes a media file (URL, upload or data URI). */
export function isMediaField(name, property) {
    if (!property || typeof property !== 'object') return false;
    const ui = property['x-ui'] || {};
    if (property.format === 'uri' || ui.widget === 'upload' || property.contentMediaType) return true;
    if (property.type === 'array' && (property.items?.format === 'uri' || property.items?.contentMediaType)) return true;
    return /_urls?$/.test(name);
}

/** Media fields the model requires. */
function requiredMediaFields(model) {
    const properties = propertiesOf(model);
    return requiredOf(model).filter(name => isMediaField(name, properties[name]));
}

/** The field a single picture goes into, or null. */
export function primaryImageField(model) {
    const properties = propertiesOf(model);
    const name = PRIMARY_IMAGE_FIELDS.find(field => properties[field]);
    return name ? { name, array: properties[name]?.type === 'array' } : null;
}

/** The field an optional reference picture goes into, or null. */
export function referenceImageField(model) {
    const properties = propertiesOf(model);
    const name = REFERENCE_IMAGE_FIELDS.find(field => properties[field]);
    return name ? { name, array: properties[name]?.type === 'array' } : null;
}

/** True when the model cannot run without a picture (an edit model). */
export function requiresImage(model) {
    return requiredMediaFields(model).length > 0;
}

/**
 * Whether a model can do the given job with what the extension has: a prompt, at most one
 * picture, and optionally the character avatar. Models that need two different pictures (face
 * swap) or another kind of media (a reference video) are left out.
 */
export function fitsKind(model, kind) {
    const spec = KINDS[kind];
    if (!spec || !model || model.enabled === false || model.available === false) return false;
    if (model.modality !== spec.modality) return false;
    const tasks = Array.isArray(model.tasks) ? model.tasks : [];
    if (!tasks.some(task => spec.tasks.includes(task))) return false;
    if (kind === 'chat') return true;
    const required = requiredMediaFields(model);
    const primary = primaryImageField(model);
    if (kind === 'i2v') {
        // Exactly one required picture, and it is the opening frame.
        return Boolean(primary) && required.length <= 1 && required.every(name => name === primary.name);
    }
    if (kind === 't2v') {
        return required.length === 0;
    }
    // Images: either no picture needed, or a single picture that can be the character avatar.
    return required.length === 0 || (required.length === 1 && primary && required[0] === primary.name);
}

/** The lowest price row of a model, as {price, unit}. */
export function startingPrice(model) {
    const rows = pricingRows(model);
    if (!rows.length) return null;
    return rows.reduce((low, row) => (usdToNumber(row.price) < usdToNumber(low.price) ? row : low));
}

/** @returns {Array<{variant: string, unit: string, price: string}>} */
export function pricingRows(model) {
    const rows = Array.isArray(model?.pricing) ? model.pricing : [];
    const valid = rows.filter(row => row && usdToNumber(row.price) !== null);
    if (valid.length) return valid;
    const start = model?.startingPrice;
    return start && usdToNumber(start.price) !== null ? [start] : [];
}

export function unitLabel(unit) {
    return UNIT_LABELS[unit] || String(unit || '').replace(/^per_/, '').replace(/_/g, ' ');
}

/** "from $0.025 / second" (or "$0.01 / image" when there is a single price). */
export function describeStartingPrice(model) {
    const rows = pricingRows(model);
    const start = startingPrice(model);
    if (!start) return '';
    const amount = `${formatUsd(start.price)} / ${unitLabel(start.unit)}`;
    return rows.length > 1 ? `from ${amount}` : amount;
}

function humanizeField(name) {
    const known = {
        generate_audio: 'audio',
        enable_prompt_expansion: 'prompt expansion',
        enable_web_search: 'web search',
        with_video: 'reference video',
    };
    return known[name] || String(name).replace(/_/g, ' ');
}

/** "generate_audio=false;resolution=480p" reads as "480p, no audio". */
export function prettyVariant(variant) {
    const text = String(variant || '');
    if (!text) return 'standard';
    if (!text.includes('=')) return safeDecode(text);
    const values = [];
    const switches = [];
    for (const part of text.split(';')) {
        const [name, raw = ''] = part.split('=');
        const value = safeDecode(raw);
        if (value === 'true') switches.push(humanizeField(name));
        else if (value === 'false' || value === '~') switches.push(`no ${humanizeField(name)}`);
        else values.push(value);
    }
    // Values first (480p), switches after (no audio).
    return [...values, ...switches].join(', ');
}

function safeDecode(value) {
    try {
        return decodeURIComponent(String(value).replace(/\+/g, ' '));
    } catch {
        return String(value);
    }
}

/** Price rows as display lines: [{label, price}] sorted cheapest first. */
export function priceTable(model) {
    return pricingRows(model)
        .map(row => ({ label: prettyVariant(row.variant), price: `${formatUsd(row.price)} / ${unitLabel(row.unit)}`, value: usdToNumber(row.price) }))
        .sort((a, b) => a.value - b.value);
}

/** Option label shown in a model dropdown. */
export function modelLabel(model) {
    const name = model.displayName || model.model;
    const price = describeStartingPrice(model);
    return price ? `${name} (${price})` : name;
}

/**
 * Models that fit a job, grouped by content policy (Uncensored first) and sorted by name.
 * @returns {Array<{policy: string, label: string, models: any[]}>}
 */
export function groupedModels(items, kind) {
    const fitting = (items || []).filter(model => fitsKind(model, kind));
    const groups = new Map();
    for (const model of fitting) {
        const policy = POLICY_LABELS[model.policyTier] ? model.policyTier : 'other';
        if (!groups.has(policy)) groups.set(policy, []);
        groups.get(policy).push(model);
    }
    const order = [...POLICY_ORDER, 'other'];
    return order
        .filter(policy => groups.has(policy))
        .map(policy => ({
            policy,
            label: POLICY_LABELS[policy] || 'Other',
            models: groups.get(policy).sort((a, b) => String(a.displayName || a.model).localeCompare(String(b.displayName || b.model))),
        }));
}

/**
 * The model used when the user has not picked one: the cheapest uncensored model for the job,
 * otherwise the cheapest of any policy. Prices are only compared within one billing unit.
 */
export function automaticModel(items, kind) {
    const fitting = (items || []).filter(model => fitsKind(model, kind));
    if (!fitting.length) return null;
    const unrestricted = fitting.filter(model => model.policyTier === 'unrestricted');
    const pool = unrestricted.length ? unrestricted : fitting;
    const units = new Map();
    for (const model of pool) {
        const unit = startingPrice(model)?.unit || '';
        units.set(unit, (units.get(unit) || 0) + 1);
    }
    const commonUnit = [...units.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
    const sameUnit = pool.filter(model => (startingPrice(model)?.unit || '') === commonUnit);
    const ranked = (sameUnit.length ? sameUnit : pool).slice().sort((a, b) => {
        const pa = usdToNumber(startingPrice(a)?.price) ?? Number.POSITIVE_INFINITY;
        const pb = usdToNumber(startingPrice(b)?.price) ?? Number.POSITIVE_INFINITY;
        return pa - pb || String(a.model).localeCompare(String(b.model));
    });
    return ranked[0] || null;
}

/**
 * The settings of a model worth offering in the panel: closed choices (dropdowns), on/off
 * switches and bounded whole numbers (the clip length), limited to those that change the price or
 * the shape of the result.
 * @returns {Array<{name: string, label: string, kind: 'enum'|'bool'|'int', options?: any[], min?: number, max?: number, step?: number, default?: any, description?: string, affectsPrice: boolean}>}
 */
export function optionFields(model) {
    const properties = propertiesOf(model);
    const fields = [];
    for (const [name, property] of Object.entries(properties)) {
        if (!property || typeof property !== 'object') continue;
        if (NON_OPTION_FIELDS.has(name) || isMediaField(name, property)) continue;
        const ui = property['x-ui'] || {};
        const affectsPrice = ui.affects_price === true;
        if (!affectsPrice && !COMMON_OPTION_FIELDS.has(name)) continue;
        const base = {
            name,
            label: humanizeLabel(name),
            default: property.default,
            description: typeof property.description === 'string' ? property.description : '',
            affectsPrice,
            order: typeof ui.order === 'number' ? ui.order : 0,
        };
        if (Array.isArray(property.enum) && property.enum.length) {
            fields.push({ ...base, kind: 'enum', options: property.enum });
        } else if (property.type === 'boolean') {
            fields.push({ ...base, kind: 'bool' });
        } else if (property.type === 'integer' && Number.isFinite(property.minimum) && Number.isFinite(property.maximum)) {
            fields.push({ ...base, kind: 'int', min: property.minimum, max: property.maximum, step: property.multipleOf || 1 });
        }
    }
    return fields.sort((a, b) => b.order - a.order || a.name.localeCompare(b.name));
}

function humanizeLabel(name) {
    const known = {
        aspect_ratio: 'Aspect ratio',
        duration_seconds: 'Length (seconds)',
        generate_audio: 'Generate audio',
        enable_prompt_expansion: 'Prompt expansion',
        num_outputs: 'Pictures per run',
    };
    if (known[name]) return known[name];
    const text = String(name).replace(/_/g, ' ');
    return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The saved value of an option when it is still valid for the model, otherwise undefined. */
export function validOptionValue(field, value) {
    if (value === undefined || value === null || value === '') return undefined;
    if (field.kind === 'enum') {
        const match = field.options.find(option => String(option) === String(value));
        return match === undefined ? undefined : match;
    }
    if (field.kind === 'bool') {
        if (value === true || value === 'true') return true;
        if (value === false || value === 'false') return false;
        return undefined;
    }
    if (field.kind === 'int') {
        const number = Math.round(Number(value));
        if (!Number.isFinite(number)) return undefined;
        return Math.min(field.max, Math.max(field.min, number));
    }
    return undefined;
}

/**
 * Builds the `input` object for a task.
 * @param {any} model Catalogue entry with its inputSchema
 * @param {{prompt?: string, image?: string, reference?: string, options?: Record<string, any>}} parts
 *   `image` is the picture the model works on (opening frame or edit source); `reference` is an
 *   optional reference picture (the character avatar), used only when the model has a place for it.
 */
export function buildInput(model, { prompt = '', image, reference, options = {} } = {}) {
    const properties = propertiesOf(model);
    const required = requiredOf(model);
    const input = {};
    const name = model?.displayName || model?.model || 'This model';

    const text = String(prompt || '').trim();
    if (properties.prompt) {
        if (text) {
            const max = properties.prompt.maxLength;
            input.prompt = Number.isFinite(max) && text.length > max ? text.slice(0, max) : text;
        }
    }

    for (const field of optionFields(model)) {
        const value = validOptionValue(field, options[field.name]);
        if (value !== undefined) input[field.name] = value;
    }

    const primary = primaryImageField(model);
    if (image) {
        if (!primary) {
            throw new Error(`${name} does not take a picture. Pick an image-to-video or editing model.`);
        }
        input[primary.name] = primary.array ? [image] : image;
    } else if (requiresImage(model) && reference && primary) {
        // An edit model needs a picture to work on; the reference is the only one there is.
        input[primary.name] = primary.array ? [reference] : reference;
    } else if (reference) {
        const slot = referenceImageField(model);
        if (slot && !(slot.name in input)) {
            input[slot.name] = slot.array ? [reference] : reference;
        }
    }

    const missing = required.filter(field => !(field in input) && properties[field]?.default === undefined);
    if (missing.length) {
        if (missing.includes('prompt')) {
            throw new Error('The prompt is empty.');
        }
        const media = missing.filter(field => isMediaField(field, properties[field]));
        if (media.length) {
            throw new Error(`${name} edits an existing picture (it uses the character avatar), and this chat has none to give it. Open a chat with a character that has an avatar, or pick a text-to-image model.`);
        }
        throw new Error(`${name} also needs: ${missing.join(', ')}.`);
    }
    return input;
}

/** True when the model has somewhere to put an optional reference picture. */
export function acceptsReference(model) {
    return Boolean(referenceImageField(model));
}
