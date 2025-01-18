import crypto from 'crypto'
import { sleepAwait } from "sleep-await"


function randomString() {
    const str = crypto.randomBytes(20).toString('base64').toLowerCase().replace(/[=+-/]/g, '').slice(0, 16)

    return `${str.slice(0, 4)}-${str.slice(4, 8)}-${str.slice(8, 12)}-${str.slice(12, 16)}`
}

async function findProofOfWork(data, difficulty) {
    let nonce = 0;
    while (nonce < 1000000) {
        const hash = crypto.createHash('sha256')
            .update(data + nonce)
            .digest('hex');

        let found = true;
        for (let i=0; i<difficulty; i++) {
            if ('012def'.includes(hash.charAt(i)) !== true) {
                found = false;
                break;
            }
        }
        if (found) {
            return nonce;
        }
        nonce++;
        if (nonce % 100000 === 0) {
            // free the main thread a bit
            await sleepAwait(0)
        }
    }
    return -1
}

export async function createDomainWithPOW() {
    let nonce, domain
    for (let i=0; i<100; i++) {
        domain = randomString() + '.gr8s.cloud'
        nonce = await findProofOfWork(domain, 17);
        if (nonce > 0) {
            return [domain, nonce]
        }
    }
    return [null, null]
}

/*
const difficulty = 17

console.time('solver')
let data
let result
for (let i=0; i< 100; i++) {
    data = crypto.randomUUID()
    result = findProofOfWork(data, difficulty);
    if (result > 0) {
        break;
    }
}
console.timeEnd('solver')
if (result > 0) {
    console.log(`uuid: ${data}, result: ${result}`);
} else {
    console.log('failed to find a solution in a reasonable time')
}
*/
