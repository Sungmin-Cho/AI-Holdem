# 원격 호스트 시험용 TLS 픽스처

`a`·`b` 두 쌍은 시험 전용 자체 서명 인증서다(CN·SAN `localhost`, `127.0.0.1`, 2126년까지). 원격 호스트 리스너 시험이 openssl 없이도 같은 인증서로 돌게 하려고 저장소에 둔다. 비밀이 아니며 실제 서버에 쓰면 안 된다.

다시 만들 때:

```bash
openssl req -x509 -newkey rsa:2048 -sha256 -keyout a.key -out a.crt -days 36500 -nodes \
  -subj "/CN=localhost/O=AI Holdem test fixture a" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
```
