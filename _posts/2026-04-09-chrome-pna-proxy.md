---
layout: post
title: "Chrome Private Network Access 정책에 막힌 오디오 재생 — 서버 프록시로 우회"
tags: [Java, Spring, Security, Chrome, Frontend, Backend]
---

관리자 페이지에서 사내 녹음 서버의 오디오 파일을 재생하려는데 콘솔에 이런 에러가 떴다.

```
Access to fetch at 'http://rec.internal.example.com/audio/file.mp3'
from origin 'https://admin.example.com' has been blocked by CORS policy:
...Private Network Access prelight request failed.
```

CORS 에러처럼 생겼지만 실제로는 **Chrome의 Private Network Access(PNA)** 정책 문제였다.

---

## Chrome Private Network Access란?

Chrome 98+부터 적용된 보안 정책이다.

**공개 origin**(HTTPS 공인 도메인)에서 **사설 네트워크 주소**(내부망 IP, localhost, `.internal` 도메인)로 직접 요청하면 차단된다.

```
https://admin.example.com  →  http://rec.internal.example.com  ← 차단!
(공개 origin)                  (내부망 도메인 → 사설 IP resolve)
```

내부망 서버에 CORS 헤더를 추가하면 해결될 것 같지만, PNA는 별도의 Preflight 요청을 요구한다.
그리고 이 내부 서버는 제어할 수 없는 상황이었다.

---

## 해결: 서버 사이드 프록시

백엔드 서버는 **서버끼리 통신**이므로 PNA 정책의 영향을 받지 않는다.
관리자 페이지 → 백엔드 프록시 엔드포인트 → 내부 녹음 서버 순으로 중계하도록 했다.

```java
@GetMapping("/audio/proxy")
public void proxyAudio(@RequestParam String url, HttpServletResponse response) {
    // SSRF 방지: 허용된 도메인만 프록시
    if (!url.contains("rec.example.com")) {
        response.setStatus(HttpServletResponse.SC_FORBIDDEN);
        return;
    }

    HttpURLConnection conn = null;
    try {
        conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(5_000);
        conn.setReadTimeout(30_000);
        response.setContentType("audio/mpeg");
        try (InputStream in = conn.getInputStream()) {
            StreamUtils.copy(in, response.getOutputStream());
        }
    } catch (Exception e) {
        response.setStatus(HttpServletResponse.SC_BAD_GATEWAY);
    } finally {
        if (conn != null) conn.disconnect();
    }
}
```

프론트엔드에서는 직접 URL 대신 프록시 URL을 사용한다.

```javascript
// 변경 전
const audio = new Audio('http://rec.internal.example.com/audio/file.mp3');

// 변경 후
const proxyUrl = `/audio/proxy?url=${encodeURIComponent(url)}`;
const audio = new Audio(proxyUrl);
```

---

## SSRF 방지가 핵심

프록시 엔드포인트는 임의의 URL을 받아 요청을 중계하므로, **SSRF(Server-Side Request Forgery)** 공격에 취약할 수 있다.

```
공격자: /audio/proxy?url=http://169.254.169.254/latest/meta-data/
         → 클라우드 메타데이터 탈취 시도
```

반드시 허용 도메인을 화이트리스트로 검증해야 한다.

```java
// 단순 contains 체크 (우회 가능)
if (!url.contains("rec.example.com")) { ... }

// 더 안전한 방법: URL 파싱 후 host 검증
URL parsed = new URL(url);
String host = parsed.getHost();
if (!host.equals("rec.example.com") && !host.endsWith(".rec.example.com")) {
    response.setStatus(403);
    return;
}
```

---

## 결과

- Chrome PNA 정책 우회 완료
- 개발/운영 환경 모두 동일한 코드로 동작
- SSRF 공격 방어

---

## 배운 것

- **Chrome PNA는 CORS와 다르다.** 단순히 CORS 헤더를 추가한다고 해결되지 않는다.
- 프록시를 만들 때는 반드시 **SSRF 방어**를 함께 고려해야 한다.
- `encodeURIComponent`를 빠뜨리면 URL에 특수문자가 있을 때 파라미터가 깨진다.
