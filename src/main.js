import * as htmlparser2 from 'htmlparser2'
import * as fs from 'fs'
import {diff_match_patch} from './diff_match_patch_uncompressed.js'
import chalk from 'chalk'
import { program } from 'commander'
import { minify } from 'html-minifier-terser'
import * as prompts from '@clack/prompts'
import * as tar from 'tar'
import * as $path from 'path'
import * as tmp from 'tmp'
import { glob } from 'glob'
import { createDomainWithPOW } from './pow.js'

const TERMS = `Privacy Policy and Terms of Use of cloud services gr8s and S³

Your privacy is important to us. We do not collect, store, or process any
personal data through our service, except for information that is essential to
operate and maintain the service. Additionally, we do not share any personal
information with third parties. Our CDN-like platform operates solely as a data
transmission service, and no cookies or tracking technologies are employed.

Terms of Use

By using our service, you agree to the following terms:

SERVICE SCOPE: We provide a CDN-like service for data delivery. The availability
and performance of our service depend on external networks and providers, and we
cannot guarantee uninterrupted or error-free operation.

LIABILITY: We are not liable for any damages, losses, or interruptions resulting
from service failures, including those caused by external factors beyond our
control.

PROHIBITED USE: You may not use our service for illegal, harmful, or
abusive activities.

CHANGES TO SERVICE: We reserve the right to modify or discontinue the service
with reasonable advance notice, except in circumstances of force majeure or
other events beyond our reasonable control.

Use of our service constitutes acceptance of these terms`


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
        //console.debug('attributes=', attributes)
        const attrs = this.mapAttributes(tagname, attributes)
        this.lines.push(`<${tagname} ${attrs}>`)
        if (tagname.toLowerCase() === 'title') {
            this.textReplacement = '{{ page_title }}'
        }
    }

    ontext(text) {
        if (this.textReplacement !== undefined) {
            if (this.textReplacement.trim() === text.trim()) {
                throw Error('It seems your HTML was already processed. Please use this program on raw unprocessed html')
            }

            this.lines.push(this.textReplacement)
            this.textReplacement = undefined
            return
        }

        if (text.length === 0) {
            return
        }

        this.lines.push(text)
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


function isValidDomain(domain) {
    const regex = /^(?![\d.]+)((?!-))(xn--)?[a-z0-9][a-z0-9-_]{0,61}[a-z0-9]{0,1}\.(xn--)?([a-z0-9._-]{1,61}|[a-z0-9-]{1,30})$/m
    // TODO validate tld
    return domain.match(regex)
}


function _simplify(s) {
    return s.split(/\n/g).map((l) => l.trim()).join('\n')
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

        if (op === 1) {
            lines.push(lastText.substring(-16) + chalk.bold.green(text))
            lastWasDiff = true
        }

        if (op === -1) {

            lines.push(lastText.substring(-16) + chalk.bold.red(text))
            lastWasDiff = true
        }

        if (op === 0 && lastWasDiff) {
            lines.push(text.substring(0, 16))
            lastWasDiff = false
            lines.push('\n')
        }
        lastText = text
    }
    return lines.join('')
}

async function compressDirectory(dir, files) {
    const f = tmp.fileSync({prefix: 'gr8s-dep-tar-'})
    //console.debug(`created tmp file ${f.name}`)
    await tar.create({cwd: dir, file: f.name, strict: true, portable: true, noPax: false}, files)
    const fdata = fs.readFileSync(f.name, {encoding: 'base64'})
    return fdata
}

async function main() {
    const S3S_CLOUD_API = process.env.S3S_API_ADDRESS || 'https://s3sapi-gr8s.b-cdn.net'

    program
        .name('gr8s-cli')
        .description(`A command to prepare your html code to use with gr8s server. For more details, check:
    https://gr8s-server.codoma.tech`)

    program
        .option('-f, --index <char>', 'the path of the site index.html. If not provided, it will be guessed')
        .option('-rc, --js_remove_contents', 'add JS code to remove pre-rendered content on page load')
        .option('--signup', 'create a quick account on s3 cloud')
        .option('-rl, --js_remove_links', 'add JS code to remove pre-rendered links on page load')
        .option('-m', 'switch on minifying the output html')
        .option('--deploy', 'deploy frontend assets to gr8s cloud. More info at https://s3.app.codoma.tech/')
        .option('-v, --verbose', 'switch on verbose output')


    program.parse()
    const options = program.opts()
    //console.debug('options=', options)

    prompts.intro('gr8s-cli')

    const newAccount = {}
    if (options.signup) {
        let confirm
        prompts.log.step('I will create a quick account for you on s3 cloud')
        //prompts.log.info(TERMS)

        confirm = await prompts.text({
            message: TERMS + '\n\n---\nDid you read and accept the terms above? Please type YES to confirm.',
            initialValue: '',
        })

        if (prompts.isCancel(confirm) || confirm.toLowerCase() !== 'yes') {
            prompts.cancel('you did not accept the service terms of use, we cannot create an account for you.')
            return
        }

        if (false && (!confirm || prompts.isCancel(confirm))) {
            prompts.log.info('no account will be created.')
        } else {
            let domain, nonce
            await prompts.tasks([
                {
                    title: 'we are finding a unique domain for you, this may take some time ...',
                    task: async () => {
                        [domain, nonce] = await createDomainWithPOW()
                        return `found a domain ${domain}`
                    },
                },
            ])
            const result = await fetch(`${S3S_CLOUD_API}/site/${domain}`, {
                headers: {
                    'cache-control': 'no-cache',
                    'pragma': 'no-cache',
                    'x-pow-nonce': nonce
                },
                'method': 'POST',
            })
            if ((result.status/100 | 0) !== 2) {
                prompts.cancel(`Failed to create an account. Status: ${result.status}`)
                return
            }
            const data = await result.json()
            //console.debug(data)
            const msg = (
                chalk.bold('Your account credentials:\n') +
                '\tDomain:  ' + chalk.bold.blue(data.domain) +
                '\n\tAPI Key: ' + chalk.bold.blue(data.api_key) + '\n\n' +
                chalk.bold.red(`Please keep your credentials in a safe place to keep your account.`) )
            prompts.log.success(`Account created succcessfully!`)
            prompts.log.info(msg)
            while (true) {
                confirm = await prompts.confirm({message: 'Did you save your credentials in a safe place?'})
                if (prompts.isCancel(confirm)) {
                    prompts.cancel('aborted')
                    return
                }
                if (confirm) {
                    break
                }
                prompts.log.error('This is a very bad idea, please save them and try again.')
            }
            newAccount.domain = data.domain
            newAccount.apiKey = data.api_key

        }
    }

    let domain = newAccount.domain || process.env.S3S_CLOUD_DOMAIN
    let apiKey = newAccount.apiKey || process.env.S3S_CLOUD_API_KEY
    if (options.deploy) {
        let verified = false
        prompts.log.step('I will deploy your frontend assets to gr8s cloud')
        while (!verified) {
            domain || prompts.log.info('you need to register an account with your domain name at https://s3.app.codoma.tech/.\n' +
                            'Optionally you can provide your credentials using environment variables S3S_CLOUD_DOMAIN and S3S_CLOUD_API_KEY')
            domain = domain || await prompts.text({
                message: 'What is your registerd domain name?',
                placeholder: 'e.g. www.something.com',
                initialValue: '',
                validate(value) {
                    if (!isValidDomain(value)) {
                        return `domain name is invalid`
                    }
                    // TODO validate tld
                },
            })
            if (prompts.isCancel(domain)) {
                prompts.cancel('Operation cancelled.')
                return
            }
            apiKey = apiKey || await prompts.text({
                message: 'What is your API key?',
                placeholder: 'e.g. abefc2095ef01a23fdd',
                initialValue: '',
                validate(value) {
                    const regex = /^[0-9a-f]+$/m
                    if (!value.match(regex)) {
                        return `invalid API key`
                    }

                    if (value.length < 16) {
                        return 'API key looks too short'
                    }
                },
            })
            if (prompts.isCancel(apiKey)) {
                prompts.cancel('Operation cancelled.')
                return
            }

            const result = await fetch(`${S3S_CLOUD_API}/site/${domain}/verified`, {
                headers: {
                    'cache-control': 'no-cache',
                    'pragma': 'no-cache',
                    'x-api-key': apiKey
                },
                'method': 'GET',
            })
            //console.debug('result', result)
            verified = (result.status/100 | 0) !== 200
            if (!verified) {
                domain = ''
                apiKey = ''
                prompts.log.error('It seems the login details are not correct!')
                prompts.log.info('From here you can either retry with correct credentials, or abort and call this script without the deploy option')
                const retry = await prompts.confirm({message: 'Retry with correct credentials?'})
                if (!retry || prompts.isCancel(retry)) {
                    prompts.cancel('Aborting due to invalid deployment credentials')
                    return
                }
            }
        }
        prompts.log.success(`logged in to S³ cloud with domain ${domain}`)
    }

    if (!options.index) {
        prompts.log.info('No index.html path provided. Trying to guess ...')
        const paths = [
            {framework: 'next.js', path: 'out/index.html'},
            {framework: 'nuxt.js', path: 'dist/index.html'},
        ]
        let found
        for (const {framework, path} of paths) {
            if (fs.existsSync(path)) {
                found = path
                prompts.log.success(`Found one in ${path}, you (probably) use ${framework}`)
                break
            }
        }
        if (!found) {
            prompts.log.error('Failed to find index.html, please specify it explicity')
            return
        }
        options.index  =found
    }

    const scanner = new HtmlScanner({
        removePrerenderedContent: options.js_remove_contents === true,
        removePrerenderedLinks: options.js_remove_links === true,
    })

    const parser = new htmlparser2.Parser(scanner)
    let html = fs.readFileSync(options.index, 'utf-8')

    try {
        parser.write(html)
    } catch (e) {
        prompts.log.error(`Error processing the file:\n\t${e.message}`)
        prompts.outro('aborting due to processing errors')
        return
    }
    parser.end()


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
    dmp.diff_cleanupSemantic(diff)


    if (options.verbose) {
        prompts.log.info('Enriched index.html. Here is the diff:')
        prompts.log.info('\t' + prettyPrintDiff(diff).replace(/\n/g, '\n\t> '))
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

    prompts.log.info(chalk.bold.blue(`The original source was backed up in ${bkup}`))
    prompts.log.success(`Your gr8s-enabled html file is in ${options.index}.`)


    if (options.deploy) {
        prompts.log.step('Deploying your frontend assets to gr8s cloud')
        const dir = $path.dirname(options.index)
        let files = await glob(`${dir}/*`)
        files = files.map((f) => f.slice(dir.length+1))
        //console.debug('files=', files)
        const fdata = await compressDirectory(dir, files)
        //console.debug(fdata.slice(0, 32))
        //console.debug(`create tar file data ${fdata.slice(0, 64)}`)


        const path = '@gr8s-cloud-files'
        const res = await fetch(`${S3S_CLOUD_API}/site/${domain}/file/${path}`, {
            method: 'POST',
            headers: {
                'x-api-key': apiKey,
                'Content-Type': 'text/plain',
            },
            body: fdata,
        })

        if ((res.status/100 | 0) !== 2) {
            prompts.log.error('Unfortunately we cannot deploy your frontend assets at this moment, please try again later')
        }
        //console.debug('result status', res.status)
        //console.debug('result text', await res.text())
        prompts.log.success(`${files.length} files deployed successfully!`)

    }

    if (apiKey) {

        // check and show deployment info
        const res = await fetch(`${S3S_CLOUD_API}/site/${domain}/files-list`, {
            method: 'GET',
            headers: {
                'x-api-key': apiKey,
            },
        })

        let files = []
        if ((res.status/100 | 0) !== 2) {
            prompts.log.error('Cannot query files at the moment, please try again later')
        } else {
            files = await res.json()
        }

        let ddomain = '', ds = '', sm = '', n=0
        for (const f of files) {
            if (f.startsWith('@deployment ')) {
                ddomain = 'https://' + f.slice(12)
            }
            if (f.startsWith('public__') && f.endsWith('_datasource.json')) {
                ds = `${S3S_CLOUD_API}/site/${domain}/file/${f}`
            }
            if (f.startsWith('public__') && f.endsWith('_sitemap.xml')) {
                sm = `${S3S_CLOUD_API}/site/${domain}/file/${f}`
            }
            if (f.endsWith('.s3s')) {
                n ++
            }
        }

        if (n || ddomain || ds || sm) {
            prompts.log.info(
                chalk.bold('Your deployment has the following:\n') +
                (ddomain? `✨ your site is deployed on CDN at ${chalk.blue(ddomain)}\n`: '') +
                (!ddomain && ds? `✨ a data source (usable by gr8s server): ${chalk.blue(ds)} \n`: '') +
                (sm? `✨ a sitemap of your website is ready to use at ${chalk.blue(sm)}\n`: '') +
                (`✨ ${chalk.blue(n)} S³ projects.\n\tyou can create/edit more at https://s3.app.codoma.tech/ (login with your domain & api key).`)
            )
        }
    }

    prompts.outro('processing concluded successfully')
}


main()
