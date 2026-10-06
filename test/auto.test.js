import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    DEFAULT_EVERY,
    addSpend,
    capAllows,
    cooldownAllows,
    countReplies,
    createDailySpendStore,
    dayKey,
    findPictureTags,
    normalizeTagName,
    parseEvery,
    repliesUntilAllowed,
    spentOn,
    stripPictureTags,
    tagInstruction,
} from '../src/auto.js';

// -- Tag parser ------------------------------------------------------------------

test('the tag name falls back to pic unless it is a plain word', () => {
    assert.equal(normalizeTagName('pic'), 'pic');
    assert.equal(normalizeTagName('<scene>'), 'scene');
    assert.equal(normalizeTagName(' img_2 '), 'img_2');
    assert.equal(normalizeTagName(''), 'pic');
    assert.equal(normalizeTagName('two words'), 'pic');
    assert.equal(normalizeTagName('a"b'), 'pic');
    assert.equal(normalizeTagName(undefined), 'pic');
});

test('a tag with a double-quoted prompt is found and removed', () => {
    const text = 'She opens the door.\n\n<pic prompt="a woman in a red coat at an open door, evening light">';
    const tags = findPictureTags(text);
    assert.equal(tags.length, 1);
    assert.equal(tags[0].prompt, 'a woman in a red coat at an open door, evening light');
    const stripped = stripPictureTags(text);
    assert.equal(stripped.text, 'She opens the door.');
    assert.deepEqual(stripped.prompts, ['a woman in a red coat at an open door, evening light']);
    assert.equal(stripped.changed, true);
});

test('single quotes, self-closing tags, closing tags and any letter case are accepted', () => {
    assert.equal(findPictureTags('<pic prompt=\'a quiet harbour\'/>')[0].prompt, 'a quiet harbour');
    assert.equal(findPictureTags('<PIC Prompt="a quiet harbour" />')[0].prompt, 'a quiet harbour');
    assert.equal(findPictureTags('<pic prompt="a quiet harbour"></pic>')[0].prompt, 'a quiet harbour');
    assert.equal(findPictureTags('<pic prompt=“a quiet harbour”>')[0].prompt, 'a quiet harbour');
    const stripped = stripPictureTags('Before <pic prompt="a quiet harbour"></pic> after.');
    assert.equal(stripped.text, 'Before after.');
});

test('the description can be the content of the tag', () => {
    const tags = findPictureTags('Text.\n<pic>a lighthouse on a cliff at dusk</pic>');
    assert.equal(tags.length, 1);
    assert.equal(tags[0].prompt, 'a lighthouse on a cliff at dusk');
    assert.equal(stripPictureTags('Text.\n<pic>a lighthouse on a cliff at dusk</pic>').text, 'Text.');
});

test('quoted values may hold > and escaped quotes, and entities are decoded', () => {
    const tags = findPictureTags('<pic prompt="a sign that reads \\"open\\" -> left, rain &amp; fog">');
    assert.equal(tags[0].prompt, 'a sign that reads "open" -> left, rain & fog');
    assert.equal(findPictureTags('<pic prompt="a &quot;quoted&quot; word &#39;here&#39;">')[0].prompt, 'a "quoted" word \'here\'');
});

test('whitespace in the prompt is collapsed', () => {
    assert.equal(findPictureTags('<pic prompt="  two\n  lines \t here ">')[0].prompt, 'two lines here');
});

test('several tags are all removed and their prompts kept in order', () => {
    const text = '<pic prompt="first">One.\n\n\n<pic prompt="second">\nTwo.';
    const stripped = stripPictureTags(text);
    assert.deepEqual(stripped.prompts, ['first', 'second']);
    assert.equal(stripped.text, 'One.\n\nTwo.');
});

test('other tags, longer tag names and unfinished tags are left alone', () => {
    const text = 'A <picture> element, a <pick prompt="x"> and <b>bold</b>. <pic prompt="unfinished';
    assert.deepEqual(findPictureTags(text), []);
    const stripped = stripPictureTags(text);
    assert.equal(stripped.changed, false);
    assert.equal(stripped.text, text);
});

test('an empty prompt is found but not returned as a prompt', () => {
    const stripped = stripPictureTags('Hello <pic prompt=""> there <pic>');
    assert.equal(stripped.text, 'Hello there');
    assert.deepEqual(stripped.prompts, []);
    assert.equal(stripped.changed, true);
});

test('a custom tag name is used instead of pic', () => {
    const text = '<scene prompt="a forest clearing"> <pic prompt="ignored">';
    assert.deepEqual(findPictureTags(text, 'scene').map(tag => tag.prompt), ['a forest clearing']);
    assert.equal(stripPictureTags(text, 'scene').text, '<pic prompt="ignored">');
});

test('a stray closing tag is removed with the tag', () => {
    const stripped = stripPictureTags('<pic prompt="a garden">A garden.</pic>');
    assert.equal(stripped.text, 'A garden.');
    assert.deepEqual(stripped.prompts, ['a garden']);
});

test('the instruction names the configured tag and stays neutral', () => {
    const text = tagInstruction('scene');
    assert.match(text, /<scene prompt="description of the picture">/);
    assert.doesNotMatch(text, /<pic/);
    assert.match(tagInstruction('bad name'), /<pic prompt=/);
});

// -- Cooldown ------------------------------------------------------------------------

const user = text => ({ is_user: true, mes: text });
const ai = text => ({ is_user: false, mes: text });

test('replies are counted without system messages and pictures from this extension', () => {
    const chat = [
        ai('greeting'),
        user('hi'),
        ai('reply 1'),
        { is_system: true, mes: 'tool calls' },
        { is_user: false, is_system: false, mes: 'picture', extra: { spicyapi: { taskId: 'job_1' } } },
        user('next'),
        ai('reply 2'),
    ];
    assert.equal(countReplies(chat), 3);
});

test('a reply that is still being written counts when the user spoke last', () => {
    assert.equal(countReplies([ai('greeting'), user('hi')]), 2);
    assert.equal(countReplies([ai('greeting'), user('hi'), { is_system: true, mes: 'note' }]), 2);
    assert.equal(countReplies([]), 0);
    assert.equal(countReplies(null), 0);
});

test('the cooldown allows one picture every N replies', () => {
    assert.equal(cooldownAllows({ replies: 5, lastReplies: null, every: 3 }), true);
    assert.equal(cooldownAllows({ replies: 5, lastReplies: 5, every: 3 }), false, 'same reply');
    assert.equal(cooldownAllows({ replies: 7, lastReplies: 5, every: 3 }), false);
    assert.equal(cooldownAllows({ replies: 8, lastReplies: 5, every: 3 }), true);
    assert.equal(cooldownAllows({ replies: 6, lastReplies: 5, every: 1 }), true);
    assert.equal(cooldownAllows({ replies: 5, lastReplies: 5, every: 1 }), false, 'never two for one reply');
    assert.equal(repliesUntilAllowed({ replies: 6, lastReplies: 5, every: 3 }), 2);
    assert.equal(repliesUntilAllowed({ replies: 9, lastReplies: 5, every: 3 }), 0);
});

test('the cooldown starts over when messages were deleted', () => {
    assert.equal(cooldownAllows({ replies: 2, lastReplies: 9, every: 3 }), true);
});

test('the cooldown setting is a whole number of at least one', () => {
    assert.equal(parseEvery(''), DEFAULT_EVERY);
    assert.equal(parseEvery(undefined), DEFAULT_EVERY);
    assert.equal(parseEvery('abc'), DEFAULT_EVERY);
    assert.equal(parseEvery(0), 1);
    assert.equal(parseEvery(-4), 1);
    assert.equal(parseEvery('2.7'), 2);
    assert.equal(parseEvery(5), 5);
});

test('the cooldown follows a conversation turn by turn', () => {
    const chat = [ai('greeting'), user('one')];
    let last = null;
    const tryPicture = () => {
        const replies = countReplies(chat);
        if (!cooldownAllows({ replies, lastReplies: last, every: 2 })) return false;
        last = replies;
        return true;
    };
    assert.equal(tryPicture(), true, 'first picture, asked for while the reply is written');
    assert.equal(tryPicture(), false, 'a second call in the same reply');
    chat.push(ai('reply one'));
    assert.equal(tryPicture(), false, 'the same reply, now finished');
    chat.push(user('two'));
    assert.equal(tryPicture(), false, 'one reply later');
    chat.push(ai('reply two'), user('three'));
    assert.equal(tryPicture(), true, 'two replies later');
});

// -- Daily cap ---------------------------------------------------------------------------

test('the day key is the local calendar day', () => {
    assert.equal(dayKey(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
    assert.equal(dayKey(new Date(2026, 11, 31, 0, 0)), '2026-12-31');
});

test('spending adds up within a day and starts over the next day', () => {
    let record = null;
    record = addSpend(record, 0.01, '2026-10-06');
    record = addSpend(record, '0.02', '2026-10-06');
    assert.equal(spentOn(record, '2026-10-06'), 0.03);
    assert.equal(spentOn(record, '2026-10-07'), 0);
    record = addSpend(record, 0.05, '2026-10-07');
    assert.deepEqual(record, { day: '2026-10-07', spent: 0.05 });
    assert.equal(addSpend(record, -1, '2026-10-07').spent, 0.05, 'negative amounts are ignored');
    assert.equal(addSpend(record, 'n/a', '2026-10-07').spent, 0.05);
    assert.equal(spentOn({ day: '2026-10-07', spent: 'junk' }, '2026-10-07'), 0);
});

test('the cap lets a run through only when it fits', () => {
    assert.equal(capAllows({ spent: 0.4, cost: 0.1, cap: 0.5 }), true);
    assert.equal(capAllows({ spent: 0.45, cost: 0.1, cap: 0.5 }), false);
    assert.equal(capAllows({ spent: 0.5, cost: 0, cap: 0.5 }), true);
    assert.equal(capAllows({ spent: 0.1 + 0.2, cost: 0.2, cap: 0.5 }), true, 'floating point noise does not block');
    assert.equal(capAllows({ spent: 0, cost: 0.01, cap: 0 }), false, 'a cap of 0 blocks everything');
    assert.equal(capAllows({ spent: 100, cost: 100, cap: null }), true, 'no cap');
});

function memoryStorage() {
    const data = new Map();
    return {
        getItem: key => (data.has(key) ? data.get(key) : null),
        setItem: (key, value) => data.set(key, String(value)),
        data,
    };
}

test('the daily store persists in storage and resets on a new day', () => {
    const storage = memoryStorage();
    let now = new Date(2026, 9, 6, 22, 0);
    const store = createDailySpendStore(storage, 'spend', () => now);
    assert.equal(store.spentToday(), 0);
    store.add(0.01);
    store.add(0.02);
    assert.equal(store.spentToday(), 0.03);
    assert.deepEqual(JSON.parse(storage.data.get('spend')), { day: '2026-10-06', spent: 0.03 });

    const again = createDailySpendStore(storage, 'spend', () => now);
    assert.equal(again.spentToday(), 0.03, 'another page load sees the same total');

    now = new Date(2026, 9, 7, 0, 5);
    assert.equal(store.spentToday(), 0);
    store.add(0.04);
    assert.equal(store.spentToday(), 0.04);
});

test('the daily store keeps working in memory when storage is blocked', () => {
    const blocked = {
        getItem() { throw new Error('blocked'); },
        setItem() { throw new Error('blocked'); },
    };
    const store = createDailySpendStore(blocked, 'spend', () => new Date(2026, 9, 6));
    store.add(0.02);
    store.add(0.03);
    assert.equal(store.spentToday(), 0.05);
    const none = createDailySpendStore(null, 'spend', () => new Date(2026, 9, 6));
    none.add(0.01);
    assert.equal(none.spentToday(), 0.01);
});

test('corrupt stored data counts as nothing spent', () => {
    const storage = memoryStorage();
    storage.setItem('spend', '{not json');
    const store = createDailySpendStore(storage, 'spend', () => new Date(2026, 9, 6));
    assert.equal(store.spentToday(), 0);
    store.add(0.01);
    assert.equal(store.spentToday(), 0.01);
});
