/**
 * SigV4 against the examples AWS publishes in the S3 API reference
 * ("Signature Calculations for the Authorization Header" and "Authenticating
 * Requests: Using Query Parameters").
 * Run: node --test src/files/*.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

// @ts-expect-error -- Node's type stripping needs the real .ts extension.
import { canonicalQuery, presignUrl, sha256Hex, signRequest, uriEncode } from "./sigv4.ts";

const creds = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };
const date = new Date("2013-05-24T00:00:00Z");
const host = "examplebucket.s3.amazonaws.com";
const base = { host, region: "us-east-1", date };

test("GET object (Range header)", async () => {
	const { signature, headers } = await signRequest({ ...base, method: "GET", path: "/test.txt", headers: { range: "bytes=0-9" } }, creds);
	assert.equal(signature, "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
	assert.match(headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20130524\/us-east-1\/s3\/aws4_request,SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,Signature=f0e8/);
});

test("PUT object (encoded key, signed body)", async () => {
	const body = "Welcome to Amazon S3.";
	const payload = await sha256Hex(body);
	assert.equal(payload, "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072");
	const { signature } = await signRequest(
		{
			...base,
			method: "PUT",
			path: "/test$file.text",
			headers: { date: "Fri, 24 May 2013 00:00:00 GMT", "x-amz-storage-class": "REDUCED_REDUNDANCY" },
		},
		creds,
		payload,
	);
	assert.equal(signature, "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd");
});

test("GET bucket lifecycle (valueless query parameter)", async () => {
	const { signature } = await signRequest({ ...base, method: "GET", path: "/", query: { lifecycle: "" } }, creds);
	assert.equal(signature, "fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543");
});

test("GET bucket list (sorted query)", async () => {
	const { signature } = await signRequest({ ...base, method: "GET", path: "/", query: { prefix: "J", "max-keys": "2" } }, creds);
	assert.equal(signature, "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7");
});

test("presigned GET URL", async () => {
	const { url, signature } = await presignUrl({ ...base, method: "GET", path: "/test.txt" }, creds, 86400);
	assert.equal(signature, "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404");
	assert.equal(
		url,
		"https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
	);
});

test("URI encoding and query order", () => {
	assert.equal(uriEncode("a b/ü~*", false), "a%20b/%C3%BC~%2A");
	assert.equal(uriEncode("a/b"), "a%2Fb");
	assert.equal(canonicalQuery({ uploadId: "x y", partNumber: "2" }), "partNumber=2&uploadId=x%20y");
});
