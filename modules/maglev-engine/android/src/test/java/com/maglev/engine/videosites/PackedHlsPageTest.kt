package com.maglev.engine.videosites

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class PackedHlsPageTest {
    private fun packed(payload: String) =
        """<script>eval(function(p,a,c,k,e,d){return p;}('$payload',4,4,'https|cdn.test|master|m3u8'.split('|'),0,{}))</script>"""

    @Test
    fun `reads HLS configuration without script execution and preserves its query`() {
        val html = packed("""player({sources:[{file:"0://1/2.3?test=a%2Bb&mode=one"}]})""")
        assertEquals("https://cdn.test/master.m3u8?test=a%2Bb&mode=one", PackedHlsPage.findPlaylist(html))
    }

    @Test
    fun `ambiguous results and insecure links are not offered`() {
        assertNull(PackedHlsPage.findPlaylist(packed(""""0://1/2.3","0://1/alt.3"""")))
        assertNull(PackedHlsPage.findPlaylist(packed(""""http://1/2.3"""")))
        assertNull(PackedHlsPage.findPlaylist(packed(""""0://user@1/2.3"""")))
    }

    @Test
    fun `only supported public player pages are fetched`() {
        assertNotNull(PackedHlsPage.pageUri("https://lplaygo.com/d/sample"))
        assertNotNull(PackedHlsPage.pageUri("https://lplaygo.com/e/sample"))
        assertNull(PackedHlsPage.pageUri("https://lplaygo.com.other.test/d/sample"))
        assertNull(PackedHlsPage.pageUri("https://other.test@lplaygo.com/d/sample"))
        assertNull(PackedHlsPage.pageUri("https://lplaygo.com:444/d/sample"))
        assertNull(PackedHlsPage.pageUri("https://lplaygo.com:/d/sample"))
        assertNull(PackedHlsPage.pageUri("https://lplaygo.com:0443/d/sample"))
        assertNull(PackedHlsPage.pageUri("https://lplaygo.com/D/sample"))
        assertNull(PackedHlsPage.pageUri("https://lplaygo.com/d/../sample"))
        assertNull(PackedHlsPage.pageUri("http://lplaygo.com/d/sample"))
        assertNotNull(PackedHlsPage.pageUri("HTTPS://LPLAYGO.COM:443/e/Sample_2/"))
    }

    @Test(timeout = 2000)
    fun `malformed repeated packer prefixes finish without rescanning the page`() {
        assertNull(PackedHlsPage.findPlaylist("eval(function(p,a,c,k,e,d)".repeat(20_000)))
    }

    @Test
    fun `oversized pages and expanded payloads are rejected`() {
        assertNull(PackedHlsPage.findPlaylist("x".repeat(1024 * 1024 + 1)))
        val expanded = """eval(function(p,a,c,k,e,d){return p;}('${"0 ".repeat(2048)}',2,1,'${"x".repeat(1024)}'.split('|'),0,{}))"""
        assertNull(PackedHlsPage.findPlaylist(expanded))
    }

    @Test
    fun `decoded limit covers all blocks together`() {
        val valid = packed(""""0://1/2.3"""")
        val expanded = """eval(function(p,a,c,k,e,d){return p;}('${"0 ".repeat(512)}',2,1,'${"x".repeat(1024)}'.split('|'),0,{}))"""
        assertEquals("https://cdn.test/master.m3u8", PackedHlsPage.findPlaylist(valid + expanded))
        assertNull(PackedHlsPage.findPlaylist(valid + expanded + expanded))
    }

    @Test
    fun `real packer function structure is decoded only as configuration text`() {
        val html = """<script>eval(function(p,a,c,k,e,d){e=function(c){return(c<a?'':e(parseInt(c/a)))+((c=c%a)>35?String.fromCharCode(c+29):c.toString(36))};if(!''.replace(/^/,String)){while(c--)d[e(c)]=k[c]||e(c);k=[function(e){return d[e]}];e=function(){return'\\w+'};c=1};while(c--)if(k[c])p=p.replace(new RegExp('\\b'+e(c)+'\\b','g'),k[c]);return p}('player({file:"0://1/2.3?fixture=a%2Bb"})',4,4,'https|cdn.test|master|m3u8'.split('|'),0,{}))</script>"""
        assertEquals("https://cdn.test/master.m3u8?fixture=a%2Bb", PackedHlsPage.findPlaylist(html))
    }
}
