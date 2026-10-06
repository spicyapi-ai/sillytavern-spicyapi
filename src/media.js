/**
 * Moving pictures and clips between SillyTavern, the browser and SpicyAPI.
 *
 * Reference pictures (an avatar, an image in the chat) are sent to SpicyAPI inline as a data URI,
 * which the API accepts for images up to 1 MiB, so no separate upload step is needed. Results are
 * downloaded and saved into SillyTavern's own image folder, so they keep working after the
 * short-lived download link expires.
 */

// The API accepts inline images up to 1 MiB decoded, 8192 px per side and 8,388,608 px in total.
// Stay a little under each limit.
const INLINE_MAX_BYTES = 1_000_000;
const INLINE_MAX_SIDE = 2048;
const INLINE_MAX_PIXELS = 4_194_304;

const EXTENSION_BY_MIME = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/bmp': 'bmp',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/ogg': 'ogg',
};

/** File extension SillyTavern's upload endpoint accepts for a MIME type, or ''. */
export function extensionForMime(mime) {
    return EXTENSION_BY_MIME[String(mime || '').split(';')[0].trim().toLowerCase()] || '';
}

/** @param {string} mime */
export function mediaTypeForMime(mime) {
    const value = String(mime || '');
    if (value.startsWith('video/')) return 'video';
    if (value.startsWith('audio/')) return 'audio';
    return 'image';
}

/** Base64 (without the data: prefix) of a Blob. */
export function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = String(reader.result || '');
            resolve(result.slice(result.indexOf(',') + 1));
        };
        reader.onerror = () => reject(reader.error || new Error('Could not read the file.'));
        reader.readAsDataURL(blob);
    });
}

function blobToDataUri(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error || new Error('Could not read the file.'));
        reader.readAsDataURL(blob);
    });
}

function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
        canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('Could not encode the picture.'))), type, quality);
    });
}

/** True when a URL points at this SillyTavern server (or is relative to it). */
export function isSameOrigin(url) {
    try {
        return new URL(url, location.href).origin === location.origin;
    } catch {
        return false;
    }
}

/**
 * A picture from SillyTavern (an avatar or a chat image) as a data URI SpicyAPI accepts inline.
 * Pictures that are too large are scaled down and re-encoded as JPEG.
 *
 * A picture hosted elsewhere on the web is returned as its https URL instead, which SpicyAPI
 * fetches itself.
 * @param {string} url
 * @returns {Promise<string>}
 */
export async function pictureForApi(url) {
    if (!url) throw new Error('No picture was given.');
    if (url.startsWith('data:image/')) {
        return shrinkDataUri(url);
    }
    if (!isSameOrigin(url)) {
        if (/^https:\/\//i.test(url)) return url;
        throw new Error('Only pictures stored in SillyTavern or public https links can be used.');
    }
    const response = await fetch(url, { cache: 'force-cache' });
    if (!response.ok) {
        throw new Error(`Could not read the picture from SillyTavern (HTTP ${response.status}).`);
    }
    const blob = await response.blob();
    return blobForApi(blob);
}

async function shrinkDataUri(dataUri) {
    const response = await fetch(dataUri);
    return blobForApi(await response.blob());
}

/** @param {Blob} blob */
async function blobForApi(blob) {
    const type = String(blob.type || '').toLowerCase();
    const passThrough = ['image/png', 'image/jpeg', 'image/webp'].includes(type);
    const bitmap = await createImageBitmap(blob);
    try {
        const { width, height } = bitmap;
        const fits = Math.max(width, height) <= INLINE_MAX_SIDE && width * height <= INLINE_MAX_PIXELS;
        if (passThrough && fits && blob.size <= INLINE_MAX_BYTES) {
            return blobToDataUri(blob);
        }
        let scale = Math.min(1, INLINE_MAX_SIDE / Math.max(width, height), Math.sqrt(INLINE_MAX_PIXELS / (width * height)));
        for (let attempt = 0; attempt < 6; attempt++) {
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(width * scale));
            canvas.height = Math.max(1, Math.round(height * scale));
            const context = canvas.getContext('2d');
            // JPEG has no transparency: paint transparent areas white rather than black.
            context.fillStyle = '#ffffff';
            context.fillRect(0, 0, canvas.width, canvas.height);
            context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            for (const quality of [0.92, 0.85, 0.75]) {
                const encoded = await canvasToBlob(canvas, 'image/jpeg', quality);
                if (encoded.size <= INLINE_MAX_BYTES) {
                    return blobToDataUri(encoded);
                }
            }
            scale *= 0.75;
        }
        throw new Error('The picture could not be made small enough to send.');
    } finally {
        bitmap.close?.();
    }
}

/**
 * Saves a result into SillyTavern's user images folder and returns its local path.
 * @param {Blob} blob
 * @param {{folder: string, filename: string, headers: Record<string,string>}} target
 */
export async function saveToSillyTavern(blob, { folder, filename, headers }) {
    const format = extensionForMime(blob.type);
    if (!format) {
        throw new Error(`SillyTavern cannot store a ${blob.type || 'file of unknown type'}.`);
    }
    const image = await blobToBase64(blob);
    const response = await fetch('/api/images/upload', {
        method: 'POST',
        headers,
        body: JSON.stringify({
            image,
            format,
            ch_name: folder,
            filename: String(filename).replace(/\./g, '_'),
        }),
    });
    if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || `SillyTavern could not save the file (HTTP ${response.status}).`);
    }
    const { path } = await response.json();
    return path;
}

/** A Blob whose type is set from the asset MIME when the server did not send one. */
export function withMime(blob, mime) {
    if (blob.type || !mime) return blob;
    return new Blob([blob], { type: mime });
}
