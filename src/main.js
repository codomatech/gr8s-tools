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
import { transformIndexHtml, isTransformed } from './gr8s-transform'

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

async function parseCommandLineOptions() {
    program
        .name('gr8s-cli')
        .description(`A command to prepare your html code to use with gr8s server. For more details, check:
    https://gr8s-server.codoma.tech`)

    program
        .option('-f, --index <char>', 'the path of the site index.html. If not provided, it will be guessed')
        .option('-rc, --js_remove_contents', 'add JS code to remove pre-rendered content on page load (on by default)')
        .option('-rl, --js_remove_links', 'add JS code to remove pre-rendered links on page load')
        .option('-m', 'switch on minifying the output html')
        .option('--deploy', 'deploy frontend assets to gr8s cloud. More info at https://gr8s-server.codoma.tech/app')
        .option('-v, --verbose', 'switch on verbose output')

    program.parse()
    return program.opts()
}

export async function cmd(options) {
    // Product-aligned env names, with the legacy S3S_* names kept working for
    // one release so existing CI does not break.
    const GR8S_API = process.env.GR8S_API_ADDRESS || process.env.S3S_API_ADDRESS ||
        'https://gr8s-server.codoma.tech/app'

    prompts.intro('gr8s-cli')

    let domain = process.env.GR8S_DOMAIN || process.env.S3S_CLOUD_DOMAIN
    let apiKey = process.env.GR8S_API_KEY || process.env.S3S_CLOUD_API_KEY
    if (options.deploy) {
        let verified = false
        prompts.log.step('I will deploy your frontend assets to gr8s cloud')
        while (!verified) {
            domain || prompts.log.info('you need to register an account with your domain name at https://gr8s-server.codoma.tech/app.\n' +
                            'Optionally you can provide your credentials using environment variables GR8S_DOMAIN and GR8S_API_KEY')
            domain = domain || await prompts.text({
                message: 'What is your registerd domain name?',
                placeholder: 'e.g. www.something.com',
                initialValue: '',
                validate(value) {
                    if (!isValidDomain(value)) {
                        return `domain name is invalid`
                    }
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

            const result = await fetch(`${GR8S_API}/site/${domain}/verified`, {
                headers: {
                    'cache-control': 'no-cache',
                    'pragma': 'no-cache',
                    'x-api-key': apiKey
                },
                'method': 'GET',
            })
            verified = (result.status/100 | 0) === 2
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
        prompts.log.success(`logged in to gr8s cloud with domain ${domain}`)
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
        options.index = found
    }

    let html = fs.readFileSync(options.index, 'utf-8')
    if (isTransformed(html)) {
        prompts.log.error('It seems your HTML was already processed. Please use this program on raw unprocessed html')
        return
    }

    let transformed
    try {
        transformed = transformIndexHtml(html, {
            removePrerenderedContent: options.js_remove_contents !== false,
            removePrerenderedLinks: options.js_remove_links === true,
        })
    } catch (e) {
        prompts.log.error(`Error processing the file:\n\t${e.message}`)
        prompts.outro('aborting due to processing errors')
        return
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
        transformed = await minify(transformed, {
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
        // TODO how to run that from the browser?
        prompts.log.step('Deploying your frontend assets to gr8s cloud')
        const dir = $path.dirname(options.index)
        let files = await glob(`${dir}/*`)
        files = files
            .map((f) => f.slice(dir.length + 1))
            // Never publish local backups (e.g. the raw index.html.bak).
            .filter((f) => !f.endsWith('.bak'))
        const fdata = await compressDirectory(dir, files)

        const path = '@gr8s-cloud-files'
        const res = await fetch(`${GR8S_API}/site/${domain}/file/${path}`, {
            method: 'POST',
            headers: {
                'x-api-key': apiKey,
                'Content-Type': 'text/plain',
            },
            body: fdata,
        })

        if ((res.status/100 | 0) !== 2) {
            const detail = (await res.text().catch(() => '')).trim()
            prompts.log.error(`Deploy failed (HTTP ${res.status}). ${detail}`)
            prompts.cancel('Deployment failed; nothing was published.')
            process.exitCode = 1
            return
        }
        const { deployment } = await res.json().catch(() => ({}))
        prompts.log.success(`${files.length} files deployed`)
        if (deployment) {
            prompts.log.info(`Your site is live at ${chalk.blue('https://' + deployment)}`)
        }
    }

    if (apiKey) {
        const res = await fetch(`${GR8S_API}/site/${domain}/files-list`, {
            method: 'GET',
            headers: {
                'x-api-key': apiKey,
            },
        })

        let files = []
        if ((res.status/100 | 0) !== 2) {
            prompts.log.warn('Could not fetch the deployed file list (the deploy itself succeeded).')
        } else {
            files = await res.json()
        }

        let ddomain = '', ds = '', sm = '', n=0
        for (const f of files) {
            if (f.startsWith('@deployment ')) {
                ddomain = 'https://' + f.slice(12)
            }
            if (f.startsWith('public__') && f.endsWith('_datasource.json')) {
                ds = `${GR8S_API}/site/${domain}/file/${f}`
            }
            if (f.startsWith('public__') && f.endsWith('_sitemap.xml')) {
                sm = `${GR8S_API}/site/${domain}/file/${f}`
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
                (`✨ ${chalk.blue(n)} S³ projects.\n\tyou can create/edit more at https://gr8s-server.codoma.tech/app (login with your domain & api key).`)
            )
        }
    }

    prompts.outro('processing concluded successfully')
}

export async function main() {
    const options = await parseCommandLineOptions()
    await cmd(options)
}
