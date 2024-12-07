import * as htmlparser2 from "htmlparser2";
import * as fs from 'fs';
import {diff_match_patch} from './diff_match_patch_uncompressed.js'
import chalk from 'chalk';
import { program } from 'commander'
import { minify } from 'html-minifier-terser'


const MAIN_PREFIX = `{% if gr8s_html_payload %}{{ gr8s_html_payload }}{% else %}<div class="prerendered-text">{{ body_text }}</div>{% endif %}
{% if gr8s_json_payload %}<script id="gr8s-json-payload" type="application/json">{{ gr8s_json_payload }}</script>{% endif %}
`

class HtmlScanner {
    constructor(opts) {
        this.lines = []
        this.textReplacement = undefined
        this.opts = opts || {}
    }

    mapAttributes(tag, attrs) {
        const lines = []
        for (const kv of Object.entries(attrs)) {
            let [name, val] = kv
            if (name == 'data-href' && tag == 'link') {
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
        //console.log('attributes=', attributes)
        const attrs = this.mapAttributes(tagname, attributes)
        this.lines.push(`<${tagname} ${attrs}>`)
        if (tagname.toLowerCase() === 'title') {
            this.textReplacement = '{{ page_title }}'
        }
    }

    ontext(text) {
        if (this.textReplacement !== undefined) {
            if (this.textReplacement.trim() === text.trim()) {
                throw Error("It seems your HTML was already processed. Please use this program on raw unprocessed html")
            }

            this.lines.push(this.textReplacement)
            this.textReplacement = undefined
            return
        }

        if (text.length === 0) {
            return;
        }

        this.lines.push(text);
    }

    onclosetag(tagname) {

        switch (tagname.toLowerCase()) {
            case 'head': {
                this.lines.push(`{% for tag in meta_tags %}<meta property="{{ tag[0] }}" content="{{ tag[1] }}">
{% endfor %}
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
                if (this.opts.removePrerenderedContent === true) {
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
        if (!['area', 'base', 'br', 'col', 'command', 'embed', 'hr', 'img', 'input', 'keygen', 'link', 'meta', 'param', 'source', 'track', 'wbr'].includes(tagname.toLowerCase()))
            this.lines.push(`</${tagname}>`)
    }
}


function _simplify(s) {
    return s.split(/\n/g).map((l) => l.trim()).join('\n')
    //return s
    //return s.replace(/[\s\n]+/gm, ' ')
}


function prettyPrintDiff(diff) {
    const lines = []
    let lastText = ''
    let lastWasDiff = false
    for (const rec of diff) {
        const op = rec[0]
        const text = rec[1]
        if (text.trim().length < 3) {
            continue
        }

        if (op == 1) {
            lines.push(lastText.substring(-16) + chalk.bold.green(text))
            lastWasDiff = true
        }

        if (op == -1) {

            lines.push(lastText.substring(-16) + chalk.bold.red(text))
            lastWasDiff = true
        }

        if (op == 0 && lastWasDiff) {
            lines.push(text.substring(0, 16))
            lastWasDiff = false
            lines.push('\n')
        }
        lastText = text
    }
    return lines.join('')
}

async function main() {
    program
        .name('gr8s-prepare-index-html')
        .description(`A command to prepare your html code to use gr8s server. For more details, check:
    https://gr8s-server.codoma.tech`)

    program
        .option('-f, --index <char>', 'the path of the site index.html. If not provided, it will be guessed')
        .option('-rc, --js_remove_contents', 'add JS code to remove pre-rendered content on page load')
        .option('-rl, --js_remove_links', 'add JS code to remove pre-rendered links on page load')
        .option('-m', 'switch on minifying the output html')
        .option('-v, --verbose', 'switch on verbose output')


    program.parse();
    const options = program.opts();
    //console.debug('options=', options)

    if (!options.index) {
        console.log(chalk.bold.blue('No index.html path provided. Trying to guess ...'))
        const paths = [
            {framework: 'next.js', path: 'out/index.html'},
            {framework: 'nuxt.js', path: 'dist/index.html'},
        ];
        let found
        for (const {framework, path} of paths) {
            if (fs.existsSync(path)) {
                found = path
                console.log(chalk.bold.green(`Found one in ${path}, you (probably) use ${framework}`))
                break
            }
        }
        if (!found) {
            console.error('Failed to find index.html, please specify it explicity')
            return
        }
        options.index = found
    }

    const scanner = new HtmlScanner({
        removePrerenderedContent: options.js_remove_contents === true,
        removePrerenderedLinks: options.js_remove_links === true,
    })

    const parser = new htmlparser2.Parser(scanner);
    let html = fs.readFileSync(options.index, 'utf-8');

    try {
        parser.write(html);
    } catch (e) {
        console.error(chalk.bold.red(`Error processing the file:\n${e.message}`))
        return
    }
    parser.end();


    let transformed = scanner.lines.join('\n')

    // <!doctype html> is not detected by html parser
    const regex = /^<!\s*doctype\s+html\s*>/gim
    const match = html.match(regex)
    if (match) {
        transformed = match[0] + transformed
    }

    const dmp = new diff_match_patch()
    dmp.Diff_Timeout = 1
    const diff = dmp.diff_main(_simplify(html), _simplify(transformed))
    dmp.diff_cleanupSemantic(diff);


    if (options.verbose) {
        console.log(chalk.bold.blue('Enriched index.html. Here is the diff:\n\t>'),
                    prettyPrintDiff(diff).replace(/\n/g, '\n\t> '))
    }
    const bkup = options.index + '.bak'
    fs.writeFileSync(bkup, html)

    if (options.m) {
        transformed = await minify(transformed,  {
            collapseWhitespace: true,
            minifyCSS: true,
            minifyJS: true,
            minifyURLs: true,
            noNewlinesBeforeTagClose: true,
            removeComments: true,
            caseSensitive: true,
        })
    }
    fs.writeFileSync(options.index, transformed)

    console.log(chalk.bold.blue(`The original source was backed up in ${bkup}`))
    console.log(chalk.bold.green(`Your gr8s-enabled html file is in ${options.index}.`))
}


main()
