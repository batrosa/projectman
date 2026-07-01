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
//       const div = document.createElement('div');
//       div.textContent = text;
//       return div.innerHTML;
//   }
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
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
});
