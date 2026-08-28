import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_flutter/api.dart';

/// Records what the client would have sent and replays a canned response.
class FakeBackend {
  FakeBackend();

  final List<Map<String, Object?>> calls = <Map<String, Object?>>[];
  final Map<String, ApiResult> responses = <String, ApiResult>{};

  ApiResult fallback = ApiResult(statusCode: 200, body: const {});

  RequestSender get sender => (method, path, body, token) async {
        calls.add({'method': method, 'path': path, 'body': body, 'token': token});
        return responses['$method $path'] ?? fallback;
      };

  void reply(String route, int statusCode, Map<String, dynamic> body) {
    responses[route] = ApiResult(statusCode: statusCode, body: body);
  }
}

void main() {
  group('ApiResult', () {
    test('reports success, the year-end lock and error text', () {
      expect(ApiResult(statusCode: 201, body: const {}).isSuccess, isTrue);
      expect(ApiResult(statusCode: 404, body: const {}).isSuccess, isFalse);

      final locked = ApiResult(statusCode: 423, body: const {'error': 'Quotes stay locked'});
      expect(locked.isLocked, isTrue);
      expect(locked.errorMessage, 'Quotes stay locked');

      final unnamed = ApiResult(statusCode: 500, body: const {});
      expect(unnamed.errorMessage, contains('500'));
    });
  });

  group('session handling', () {
    test('keeps the token from a successful sign in and sends it onwards', () async {
      final backend = FakeBackend();
      backend.reply('POST /api/auth/login', 200, {
        'token': 'session-token',
        'user': {'id': 'u1', 'displayName': 'Alice'},
      });

      final api = QuotesApi(baseUrl: 'https://example.test', sender: backend.sender);
      expect(api.isSignedIn, isFalse);

      await api.login(email: 'alice@example.com', password: 'a long enough password');
      expect(api.isSignedIn, isTrue);

      await api.me();
      expect(backend.calls.last['token'], 'session-token');
    });

    test('does not keep a token from a rejected sign in', () async {
      final backend = FakeBackend();
      backend.reply('POST /api/auth/login', 401, {'error': 'Email or password is incorrect'});

      final api = QuotesApi(baseUrl: 'https://example.test', sender: backend.sender);
      final result = await api.login(email: 'alice@example.com', password: 'wrong');

      expect(result.isSuccess, isFalse);
      expect(api.isSignedIn, isFalse);
    });

    test('signing out drops the token', () async {
      final backend = FakeBackend();
      backend.reply('POST /api/auth/register', 201, {'token': 't', 'user': const {}});

      final api = QuotesApi(baseUrl: 'https://example.test', sender: backend.sender);
      await api.register(displayName: 'Alice', email: 'a@example.com', password: 'a long password');
      api.signOut();

      expect(api.isSignedIn, isFalse);
    });
  });

  group('request shapes', () {
    late FakeBackend backend;
    late QuotesApi api;

    setUp(() {
      backend = FakeBackend();
      api = QuotesApi(baseUrl: 'https://example.test', sender: backend.sender);
    });

    test('never sends recordedByMemberId: the server attributes the quote', () async {
      await api.addQuote(
        groupId: 'g1',
        text: 'The map is wrong',
        saidByMemberId: 'm2',
        involvedMemberIds: const ['m3'],
      );

      final call = backend.calls.single;
      expect(call['method'], 'POST');
      expect(call['path'], '/api/groups/g1/quotes');
      expect(call['body'], {
        'text': 'The map is wrong',
        'saidByMemberId': 'm2',
        'involvedMemberIds': ['m3'],
      });
      expect((call['body'] as Map).containsKey('recordedByMemberId'), isFalse);
    });

    test('escapes group ids in paths', () async {
      await api.group(groupId: 'a group/with slashes');
      expect(backend.calls.single['path'], '/api/groups/a%20group%2Fwith%20slashes');
    });

    test('sends an empty involved list by default', () async {
      await api.addQuote(groupId: 'g1', text: 'Solo', saidByMemberId: 'm1');
      expect((backend.calls.single['body'] as Map)['involvedMemberIds'], isEmpty);
    });
  });

  group('readInviteCode', () {
    test('accepts a bare code', () {
      expect(readInviteCode('  abc.def  '), 'abc.def');
    });

    test('extracts the code from a pasted invite URL', () {
      expect(
        readInviteCode('https://quotes.example.workers.dev/join?invite=abc.def'),
        'abc.def',
      );
    });

    test('extracts the code from a fragment link', () {
      expect(
        readInviteCode('https://quotes.example.workers.dev/join#invite=abc.def'),
        'abc.def',
      );
    });

    test('decodes percent-escaped codes', () {
      expect(readInviteCode('https://example.test/join?invite=a%2Bb.c'), 'a+b.c');
    });
  });

  group('network errors', () {
    test('an unusable base URL raises a readable error', () async {
      final api = QuotesApi(baseUrl: 'not a url');
      expect(
        () => api.me(),
        throwsA(isA<ApiException>().having((error) => error.message, 'message', contains('not a valid'))),
      );
    });
  });
}
