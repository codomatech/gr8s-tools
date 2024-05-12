import Postmate from 'postmate';

(function() {
    // s3s-crawl-assistant: include this in your page's HTML so s3s can crawl your
    // site. The file is intentionally short (besides the dependency postmate) and
    // unobfuscated for transparency.
    if (window.location.search.endsWith('s3s-crawler-active')) {
        const handshake = new Postmate.Model({
            pageSource: () => document.body.innerHTML
        })
    }
})()
