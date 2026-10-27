// Shared gr8s HTML transform.
//
// Rewrites a raw SPA `index.html` into a gr8s template: it injects the
// placeholders the gr8s server fills from a template datasource
// (page_title, meta_tags, canonical_url, body_text / gr8s_html_payload,
// additional_links). Used by BOTH the gr8s-cli and the S³ Studio (browser), so
// the two never drift.
//
// Pure ESM, no filesystem / node builtins: htmlparser2 works in browsers too.

import * as htmlparser2 from 'htmlparser2'

export const MAIN_PREFIX = `{% if gr8s_html_payload %}{{ gr8s_html_payload }}{% else %}<div class="prerendered-text">{{ body_text }}</div>{% endif %}
{% if gr8s_json_payload %}<script id="gr8s-json-payload" type="application/json">{{ gr8s_json_payload }}</script>{% endif %}
`

const VOID_ELEMENTS = [
    'area', 'base', 'br', 'col', 'command', 'embed', 'hr', 'img', 'input',
    'keygen', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]

// A raw document already carries gr8s placeholders; transforming again would
// double-inject (and corrupt the placeholders).
export function isTransformed(html) {
    return html.includes('gr8s_html_payload') || html.includes('gr8s_json_payload') ||
        /<title[^>]*>\s*\{\{\s*page_title/.test(html)
}

export class HtmlScanner {
    constructor(opts) {
        this.lines = []
        this.opts = opts || {}
        this.bodyTextAdded = false
        this.footerLinksAdded = false
        this.alreadyProcessed = false
        // The parser can deliver a <title>'s text in several ontext calls (for
        // example when it contains entities), so buffer the whole element and
        // replace it once at </title>.
        this.inTitle = false
        this.titleText = ''
    }

    mapAttributes(tag, attrs) {
        const lines = []
        for (const kv of Object.entries(attrs)) {
            let [name, val] = kv
            if (name === 'data-href' && tag === 'link') {
                name = 'href'
            }
            let text = name
            if (val.length > 0)
                text += `="${val}"`
            lines.push(text)
        }
        return lines.join(' ')
    }

    onopentag(tagname, attributes) {
        const attrs = this.mapAttributes(tagname, attributes)
        this.lines.push(`<${tagname} ${attrs}>`)
        if (tagname.toLowerCase() === 'title') {
            this.inTitle = true
            this.titleText = ''
        }
    }

    ontext(text) {
        if (this.inTitle) {
            this.titleText += text
            return
        }
        if (text.length === 0) {
            return
        }
        this.lines.push(text)
    }

    onclosetag(tagname) {
        const lower = tagname.toLowerCase()
        if (lower === 'title' && this.inTitle) {
            this.inTitle = false
            if (this.titleText.trim() === '{{ page_title }}') {
                this.alreadyProcessed = true
            } else {
                this.lines.push('{{ page_title }}')
            }
            this.lines.push('</title>')
            return
        }
        switch (lower) {
        case 'head': {
            this.lines.push(`{% for tag in meta_tags %}<meta property="{{ tag[0] }}" content="{{ tag[1] }}">
{% endfor %}
{% if meta_og_description %}<meta name="description" content="{{ meta_og_description }}" >{% endif %}
{% if canonical_url %}<link rel="canonical" href="{{ canonical_url }}" >{% endif %}`)
            break
        }
        case 'main': {
            this.lines.push(MAIN_PREFIX)
            this.bodyTextAdded = true
            break
        }
        case 'footer': {
            this.lines.push(`{% for link in additional_links %}
<a class="add-link" href="{{ link.url }}">{{ link.title }}</a>
{% endfor %}`)
            this.footerLinksAdded = true
            break
        }
        case 'body': {
            if (this.bodyTextAdded !== true)
                this.lines.push(MAIN_PREFIX)
            if (this.footerLinksAdded !== true)
                this.lines.push(`{% for link in additional_links %}
    <a class="add-link" href="{{ link.url }}">{{ link.title }}</a>
    {% endfor %}`)
            const jscode = []
            // On by default: pre-rendered text should be removed on load unless
            // a caller explicitly opts out.
            if (this.opts.removePrerenderedContent !== false) {
                jscode.push(`document.querySelectorAll('.prerendered-text').forEach((e) => e.remove())`)
            }
            if (this.opts.removePrerenderedLinks === true) {
                jscode.push(`document.querySelectorAll('.add-link').forEach((e) => e.remove())`)
            }
            if (jscode.length > 0) {
                this.lines.push(`  <script>
  document.addEventListener("DOMContentLoaded", function() {
    ${jscode.join('\n    ')}
  })
  </script>`)
            }
            break
        }
        }
        if (!VOID_ELEMENTS.includes(tagname.toLowerCase()))
            this.lines.push(`</${tagname}>`)
    }
}

// transformIndexHtml rewrites raw html into a gr8s template. Returns the
// transformed string; throws if the input is already transformed (call
// isTransformed first to skip).
export function transformIndexHtml(html, opts) {
    const scanner = new HtmlScanner(opts)
    const parser = new htmlparser2.Parser(scanner)
    parser.write(html)
    parser.end()
    if (scanner.alreadyProcessed) {
        throw new Error('already-processed')
    }

    let transformed = scanner.lines.join('\n')
    const match = html.match(/^<!\s*doctype\s+html\s*>/im)
    if (match) {
        transformed = match[0] + transformed
    }
    return transformed
}
