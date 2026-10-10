const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ' };

// Mastodon adds "RE: <link>" to quote posts for apps that can't show quotes; apps that do, hide it
export const withoutQuoteInline = (html: string) =>
    html.replace(/<p[^>]*\bclass="[^"]*\bquote-inline\b[^"]*"[^>]*>[\s\S]*?<\/p>/gi, '');

// Post HTML as plain text, keeping paragraph and line breaks
export const plainText = (html?: string) =>
    withoutQuoteInline(html ?? '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
        .replace(/<[^>]*>/g, '')
        .replace(/&(amp|lt|gt|quot|apos|#39|nbsp);/g, (_, entity: string) => ENTITIES[entity])
        .trim();
