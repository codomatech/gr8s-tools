import Postmate from 'postmate';

(function() {
    // s3s-crawl-assistant: include this in your page's HTML so s3s can crawl your
    // site. The file is intentionally short (besides the dependency postmate) and
    // unobfuscated for transparency.
    const urlParams = new URLSearchParams(window.location.search)
    if (urlParams.has('s3-crawler-active')) {
        const handshake = new Postmate.Model({
            pageSource: () => document.body.innerHTML
        })
        try {
            window.s3s_crawl_assistant_handshake = handshake
        } catch(e) {
            console.debug('minor error: failed to set handshake to global variable', e)
        }
    }
})()
