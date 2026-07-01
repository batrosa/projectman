// @vitest-environment jsdom
//
// Regression coverage for Task 13b (stored XSS in attachment/file-list rendering).
// script.js is a large non-modular browser script (relies on globals like
// `document`, `state`, `elements`, etc. and has no exports), so it cannot be
// imported directly in a unit test. Instead this test copies the exact
// `escapeHtml` and `sanitizeAttachmentUrl` implementations verbatim from
// script.js (see script.js around line 3629 and line 221 respectively) and
// exercises them against a real jsdom `document`, matching how the fixed
// rendering functions (renderAttachmentsList, showNoPreview,
// openFilesListModal, renderCompletionAttachments, etc.) use them.
import { describe, it, expect } from "vitest";

// Verbatim copy of escapeHtml from script.js:
//   function escapeHtml(text) {
//       if (!text) return '';
//       return String(text)
//           .replace(/&/g, '&amp;')
//           .replace(/</g, '&lt;')
//           .replace(/>/g, '&gt;')
//           .replace(/"/g, '&quot;')
//           .replace(/'/g, '&#39;');
//   }
function escapeHtml(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Verbatim copy of sanitizeAttachmentUrl from script.js:
function sanitizeAttachmentUrl(url) {
    if (typeof url !== 'string') return '#';
    const trimmed = url.trim();
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    if (trimmed.startsWith('//')) return trimmed;
    if (trimmed.startsWith('/')) return trimmed;
    return '#';
}

// Builds a node the same way the fixed script.js functions do: escape/sanitize
// first, THEN place the (now-safe) value into an attribute via a template
// literal assigned to a wrapper's innerHTML — mirroring the real call sites.
function buildAttachmentLink(attachment) {
    const safeUrl = sanitizeAttachmentUrl(attachment.url);
    const wrapper = document.createElement('div');
    const namePart = 'href="' + escapeHtml(safeUrl) + '" download="' + escapeHtml(attachment.name) + '"';
    wrapper.setAttribute('data-html', '<a ' + namePart + ' class="primary-btn">Скачать файл</a>');
    wrapper.innerHTML = wrapper.getAttribute('data-html');
    return wrapper;
}

// Mirrors the avatar <img src="..."> call sites in script.js, e.g.:
//   avatar.innerHTML = `<img src="${escapeHtml(sanitizeAttachmentUrl(user.profilePhotoUrl))}" ...>`;
function buildAvatarImg(profilePhotoUrl, fullName) {
    const safeUrl = sanitizeAttachmentUrl(profilePhotoUrl);
    const wrapper = document.createElement('div');
    const html = '<img src="' + escapeHtml(safeUrl) + '" alt="' + escapeHtml(fullName) + '">';
    wrapper.setAttribute('data-html', html);
    wrapper.innerHTML = wrapper.getAttribute('data-html');
    return wrapper;
}

describe("escapeHtml (DOM-based, jsdom)", () => {
    it("neutralizes an <img onerror> XSS payload embedded in a filename", () => {
        const malicious = '<img src=x onerror=alert(1)>.pdf';
        const escaped = escapeHtml(malicious);

        expect(escaped).toBe('&lt;img src=x onerror=alert(1)&gt;.pdf');
        expect(escaped).not.toContain('<img');
        expect(escaped).not.toMatch(/<[a-z]/i);
    });

    it("renders the escaped value back into the DOM with no live elements created", () => {
        const malicious = '<img src=x onerror=alert(1)>.pdf';
        const escaped = escapeHtml(malicious);

        const container = document.createElement('div');
        const nameDiv = document.createElement('div');
        nameDiv.className = 'attachment-name';
        // Simulate what script.js does: the value placed here has ALREADY been
        // through escapeHtml, so this innerHTML assignment carries no live markup.
        container.appendChild(nameDiv);
        nameDiv.setAttribute('data-escaped', escaped);
        nameDiv.innerHTML = nameDiv.getAttribute('data-escaped');

        expect(container.querySelector('img')).toBeNull();
        expect(container.textContent).toBe(malicious);
    });

    it("passes a normal Cyrillic filename through unchanged", () => {
        const normal = 'отчёт за март.pdf';
        expect(escapeHtml(normal)).toBe(normal);
    });

    it("passes a normal ASCII filename through unchanged", () => {
        const normal = 'report-final-v2.pdf';
        expect(escapeHtml(normal)).toBe(normal);
    });

    it("escapes & < > in free text (completion comments / revision reasons)", () => {
        const text = 'Done <b>fast</b> & on time > expectations';
        expect(escapeHtml(text)).toBe('Done &lt;b&gt;fast&lt;/b&gt; &amp; on time &gt; expectations');
    });

    it("handles falsy input the same way script.js does (empty string)", () => {
        expect(escapeHtml('')).toBe('');
        expect(escapeHtml(null)).toBe('');
        expect(escapeHtml(undefined)).toBe('');
    });

    it("escapes double quotes to prevent attribute-injection", () => {
        const malicious = '" onmouseover="alert(document.cookie)';
        const escaped = escapeHtml(malicious);
        expect(escaped).not.toContain('"');
        expect(escaped).toBe('&quot; onmouseover=&quot;alert(document.cookie)');
    });

    it("escapes single quotes to prevent attribute-injection", () => {
        const malicious = "' onmouseover='alert(document.cookie)";
        const escaped = escapeHtml(malicious);
        expect(escaped).not.toContain("'");
        expect(escaped).toBe('&#39; onmouseover=&#39;alert(document.cookie)');
    });
});

describe("sanitizeAttachmentUrl", () => {
    it("neutralizes a javascript: URL to a harmless '#'", () => {
        expect(sanitizeAttachmentUrl('javascript:alert(1)')).toBe('#');
    });

    it("neutralizes other dangerous schemes (data:, vbscript:)", () => {
        expect(sanitizeAttachmentUrl('data:text/html,<script>alert(1)</script>')).toBe('#');
        expect(sanitizeAttachmentUrl('vbscript:msgbox(1)')).toBe('#');
    });

    it("passes through a normal https Cloudinary URL unchanged", () => {
        const url = 'https://res.cloudinary.com/demo/raw/upload/v1/report.pdf';
        expect(sanitizeAttachmentUrl(url)).toBe(url);
    });

    it("passes through a normal http URL unchanged", () => {
        expect(sanitizeAttachmentUrl('http://example.com/file.pdf')).toBe('http://example.com/file.pdf');
    });

    it("neutralizes a non-string url (e.g. undefined) instead of throwing", () => {
        expect(sanitizeAttachmentUrl(undefined)).toBe('#');
        expect(sanitizeAttachmentUrl(null)).toBe('#');
    });
});

describe("combined escapeHtml + sanitizeAttachmentUrl in an href/download attribute", () => {
    it("produces a safe, non-clickable-XSS anchor for a malicious url+name pair", () => {
        const attachment = {
            url: 'javascript:alert(document.cookie)',
            name: '<img src=x onerror=alert(1)>.pdf',
        };
        const wrapper = buildAttachmentLink(attachment);

        const anchor = wrapper.querySelector('a');
        expect(anchor).not.toBeNull();
        expect(anchor.getAttribute('href')).toBe('#');
        expect(anchor.getAttribute('download')).toBe(attachment.name);
        expect(wrapper.querySelector('img')).toBeNull();
    });

    it("produces an identical anchor for a normal, non-malicious url+name pair", () => {
        const attachment = {
            url: 'https://res.cloudinary.com/demo/raw/upload/v1/otchet.pdf',
            name: 'отчёт за март.pdf',
        };
        const wrapper = buildAttachmentLink(attachment);

        const anchor = wrapper.querySelector('a');
        expect(anchor.getAttribute('href')).toBe(attachment.url);
        expect(anchor.getAttribute('download')).toBe(attachment.name);
    });

    it("does not let a quote-breakout filename inject a live onmouseover attribute (href/download attribute-injection)", () => {
        const attachment = {
            url: 'https://res.cloudinary.com/demo/raw/upload/v1/report.pdf',
            name: '" onmouseover="alert(document.cookie)',
        };
        const wrapper = buildAttachmentLink(attachment);

        const anchor = wrapper.querySelector('a');
        expect(anchor).not.toBeNull();
        // Only the 3 attributes the template ever sets: href, download, class.
        expect(anchor.attributes.length).toBe(3);
        expect(anchor.getAttribute('onmouseover')).toBeNull();
        expect(anchor.getAttribute('download')).toBe(attachment.name);
        expect(anchor.getAttribute('href')).toBe(attachment.url);
    });

    it("does not let a script-tag-and-quote filename break out of the download attribute", () => {
        const attachment = {
            url: 'https://res.cloudinary.com/demo/raw/upload/v1/report.pdf',
            name: '"><script>alert(1)</script>',
        };
        const wrapper = buildAttachmentLink(attachment);

        expect(wrapper.querySelector('script')).toBeNull();
        const anchor = wrapper.querySelector('a');
        expect(anchor).not.toBeNull();
        expect(anchor.attributes.length).toBe(3);
        expect(anchor.getAttribute('download')).toBe(attachment.name);
    });
});

describe("avatar <img src/alt> attribute-injection (profilePhotoUrl)", () => {
    it("does not let a quote-breakout profilePhotoUrl inject a live onerror attribute", () => {
        // A syntactically valid https:// URL (passes sanitizeAttachmentUrl's scheme
        // check unchanged) that attempts to break out of the src="..." attribute.
        const maliciousUrl = 'https://evil.com/x.png" onerror="alert(document.cookie)';
        const wrapper = buildAvatarImg(maliciousUrl, 'Иван Иванов');

        const img = wrapper.querySelector('img');
        expect(img).not.toBeNull();
        // Only the 2 attributes the template ever sets: src, alt.
        expect(img.attributes.length).toBe(2);
        expect(img.getAttribute('onerror')).toBeNull();
        expect(img.getAttribute('src')).toBe(maliciousUrl);
    });

    it("does not let a quote-breakout fullName inject a live attribute via alt", () => {
        const url = 'https://res.cloudinary.com/demo/image/upload/v1/avatar.png';
        const maliciousName = '" onmouseover="alert(document.cookie)';
        const wrapper = buildAvatarImg(url, maliciousName);

        const img = wrapper.querySelector('img');
        expect(img).not.toBeNull();
        expect(img.attributes.length).toBe(2);
        expect(img.getAttribute('onmouseover')).toBeNull();
        expect(img.getAttribute('alt')).toBe(maliciousName);
    });

    it("produces an identical avatar img for a normal, non-malicious url+name pair", () => {
        const url = 'https://res.cloudinary.com/demo/image/upload/v1/avatar.png';
        const name = 'Иван Иванов';
        const wrapper = buildAvatarImg(url, name);

        const img = wrapper.querySelector('img');
        expect(img.attributes.length).toBe(2);
        expect(img.getAttribute('src')).toBe(url);
        expect(img.getAttribute('alt')).toBe(name);
    });
});
