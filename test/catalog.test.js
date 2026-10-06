import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
    acceptsReference,
    automaticModel,
    buildInput,
    describeStartingPrice,
    fitsKind,
    groupedModels,
    optionFields,
    prettyVariant,
    priceTable,
    requiresImage,
    validOptionValue,
} from '../src/catalog.js';

// A trimmed copy of the live catalogue (GET /api/v1/models?includeSchema=1).
const models = JSON.parse(readFileSync(new URL('./fixtures/models.json', import.meta.url), 'utf8'));
const byId = id => {
    const model = models.find(item => item.model === id);
    assert.ok(model, `fixture has ${id}`);
    return model;
};

const zImage = byId('alibaba/z-image-turbo/text-to-image');
const krea = byId('krea/2-medium-turbo/text-to-image');
const qwenEdit = byId('alibaba/qwen-image-2.1/edit');
const faceSwap = byId('spicyapi/face-swap-v1/edit');
const seedanceT2v = byId('bytedance/seedance-1.5-pro/text-to-video');
const seedanceI2v = byId('bytedance/seedance-1.5-pro/image-to-video');
const h3Reference = byId('minimax/h3/reference-to-video');
const chat = models.find(item => item.modality === 'text');

test('models are matched to the jobs they can do', () => {
    assert.ok(fitsKind(zImage, 'image'));
    assert.ok(fitsKind(krea, 'image'));
    assert.ok(fitsKind(qwenEdit, 'image'), 'an edit model takes the avatar as its picture');
    assert.ok(!fitsKind(faceSwap, 'image'), 'face swap needs two different pictures');
    assert.ok(fitsKind(seedanceT2v, 't2v'));
    assert.ok(!fitsKind(seedanceT2v, 'i2v'));
    assert.ok(fitsKind(seedanceI2v, 'i2v'));
    assert.ok(!fitsKind(h3Reference, 'i2v'), 'reference-to-video is not image-to-video');
    assert.ok(!fitsKind(zImage, 't2v'));
    assert.ok(fitsKind(chat, 'chat'));
    assert.ok(!fitsKind({ ...zImage, enabled: false }, 'image'));
});

test('the automatic choice is the cheapest uncensored model', () => {
    assert.equal(automaticModel(models, 'image').model, 'alibaba/z-image-turbo/text-to-image');
    assert.equal(automaticModel(models, 't2v').model, 'bytedance/seedance-1.5-pro/text-to-video');
    assert.equal(automaticModel(models, 'i2v').model, 'bytedance/seedance-1.5-pro/image-to-video');
});

test('models are grouped by content policy, uncensored first', () => {
    const groups = groupedModels(models, 'image');
    assert.equal(groups[0].label, 'Uncensored');
    assert.ok(groups.every(group => group.models.length > 0));
    const filtered = groups.find(group => group.policy === 'filtered');
    assert.ok(filtered.models.some(model => model.model === 'openai/gpt-image-2/text-to-image'));
});

test('prices read as rates', () => {
    assert.equal(describeStartingPrice(zImage), 'from $0.01 / image');
    assert.equal(describeStartingPrice(seedanceI2v), 'from $0.0112 / second');
    assert.equal(prettyVariant('generate_audio=false;resolution=480p'), '480p, no audio');
    assert.equal(prettyVariant('720p'), '720p');
    assert.equal(prettyVariant(''), 'standard');
    const table = priceTable(seedanceI2v);
    assert.equal(table[0].label, '480p, no audio');
    assert.equal(table[0].price, '$0.0112 / second');
});

test('only closed, price or shape settings become options', () => {
    const names = optionFields(seedanceI2v).map(field => field.name);
    assert.ok(names.includes('resolution'));
    assert.ok(names.includes('duration_seconds'));
    assert.ok(names.includes('generate_audio'));
    assert.ok(!names.includes('prompt'));
    assert.ok(!names.includes('image_url'));
    assert.ok(!names.includes('seed'));
    const duration = optionFields(seedanceI2v).find(field => field.name === 'duration_seconds');
    assert.equal(duration.kind, 'int');
    assert.equal(validOptionValue(duration, '99'), duration.max);
    assert.equal(validOptionValue(duration, ''), undefined);
    const resolution = optionFields(seedanceI2v).find(field => field.name === 'resolution');
    assert.equal(validOptionValue(resolution, '480p'), '480p');
    assert.equal(validOptionValue(resolution, '8k'), undefined);
});

test('a text-to-image input carries the prompt and saved options', () => {
    const input = buildInput(zImage, { prompt: '  a lighthouse at dusk  ', options: { aspect_ratio: '16:9' } });
    assert.deepEqual(input, { prompt: 'a lighthouse at dusk', aspect_ratio: '16:9' });
});

test('the prompt is clipped to the model limit', () => {
    const max = zImage.inputSchema.properties.prompt.maxLength;
    const input = buildInput(zImage, { prompt: 'x'.repeat(max + 50) });
    assert.equal(input.prompt.length, max);
});

test('an image-to-video input puts the picture in the opening frame', () => {
    const input = buildInput(seedanceI2v, {
        prompt: 'slow push-in',
        image: 'data:image/jpeg;base64,AAAA',
        options: { resolution: '480p', generate_audio: false, duration_seconds: 4 },
    });
    assert.equal(input.image_url, 'data:image/jpeg;base64,AAAA');
    assert.equal(input.resolution, '480p');
    assert.equal(input.generate_audio, false);
    assert.equal(input.duration_seconds, 4);
});

test('a reference picture goes where the model takes one, and nowhere else', () => {
    assert.ok(acceptsReference(krea));
    const withReference = buildInput(krea, { prompt: 'portrait', reference: 'data:image/png;base64,AAAA' });
    assert.deepEqual(withReference.reference_image_urls, ['data:image/png;base64,AAAA']);
    assert.ok(!acceptsReference(zImage));
    const without = buildInput(zImage, { prompt: 'portrait', reference: 'data:image/png;base64,AAAA' });
    assert.deepEqual(Object.keys(without), ['prompt']);
});

test('an edit model uses the reference as the picture it edits', () => {
    assert.ok(requiresImage(qwenEdit));
    const input = buildInput(qwenEdit, { prompt: 'change the background to a beach', reference: 'data:image/png;base64,AAAA' });
    assert.deepEqual(input.image_urls, ['data:image/png;base64,AAAA']);
    assert.throws(() => buildInput(qwenEdit, { prompt: 'x' }), /edits an existing picture/);
});

test('missing required input is explained', () => {
    assert.throws(() => buildInput(seedanceT2v, { prompt: '' }), /prompt is empty/);
    assert.throws(() => buildInput(seedanceT2v, { prompt: 'waves', image: 'data:image/png;base64,AAAA' }), /does not take a picture/);
});
