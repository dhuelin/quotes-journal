import 'dart:convert';
import 'dart:io';

/// Result of a single call to the Quotes Journal Worker.
class ApiResult {
  ApiResult({required this.statusCode, required this.body});

  final int statusCode;
  final Map<String, dynamic> body;

  bool get isSuccess => statusCode >= 200 && statusCode < 300;

  /// True while the group is still collecting: the Worker answers 423 for
  /// quotes, quiz and stats until 1 January of the following year.
  bool get isLocked => statusCode == 423;

  String get errorMessage {
    final error = body['error'];
    return error is String ? error : 'Something went wrong (HTTP $statusCode)';
  }
}

/// Lets tests drive the client without a socket.
typedef RequestSender = Future<ApiResult> Function(
  String method,
  String path,
  Map<String, dynamic>? body,
  String? token,
);

class ApiException implements Exception {
  ApiException(this.message);

  final String message;

  @override
  String toString() => message;
}

class QuotesApi {
  QuotesApi({required this.baseUrl, this.sender});

  final String baseUrl;

  /// Test seam: when set, requests are handed to this instead of a socket.
  final RequestSender? sender;

  /// Session token from [register] or [login]; sent as a bearer token.
  String? token;

  bool get isSignedIn => token != null;

  Future<ApiResult> register({
    required String displayName,
    required String email,
    required String password,
  }) async {
    final result = await _request('POST', '/api/auth/register', {
      'displayName': displayName,
      'email': email,
      'password': password,
    });
    _rememberToken(result);
    return result;
  }

  Future<ApiResult> login({required String email, required String password}) async {
    final result = await _request('POST', '/api/auth/login', {
      'email': email,
      'password': password,
    });
    _rememberToken(result);
    return result;
  }

  void signOut() {
    token = null;
  }

  Future<ApiResult> me() => _request('GET', '/api/auth/me', null);

  Future<ApiResult> createGroup({required String name, required int revealYear}) =>
      _request('POST', '/api/groups', {'name': name, 'revealYear': revealYear});

  Future<ApiResult> group({required String groupId}) =>
      _request('GET', '/api/groups/${Uri.encodeComponent(groupId)}', null);

  Future<ApiResult> addMember({required String groupId, required String name}) =>
      _request('POST', '/api/groups/${Uri.encodeComponent(groupId)}/members', {'name': name});

  /// The Worker attributes the quote to the signed-in caller, so there is no
  /// `recordedByMemberId` to send.
  Future<ApiResult> addQuote({
    required String groupId,
    required String text,
    required String saidByMemberId,
    List<String> involvedMemberIds = const [],
  }) =>
      _request('POST', '/api/groups/${Uri.encodeComponent(groupId)}/quotes', {
        'text': text,
        'saidByMemberId': saidByMemberId,
        'involvedMemberIds': involvedMemberIds,
      });

  Future<ApiResult> quotes({required String groupId}) =>
      _request('GET', '/api/groups/${Uri.encodeComponent(groupId)}/quotes', null);

  Future<ApiResult> quiz({required String groupId}) =>
      _request('GET', '/api/groups/${Uri.encodeComponent(groupId)}/quiz', null);

  Future<ApiResult> stats({required String groupId}) =>
      _request('GET', '/api/groups/${Uri.encodeComponent(groupId)}/stats', null);

  Future<ApiResult> invite({required String groupId}) =>
      _request('GET', '/api/groups/${Uri.encodeComponent(groupId)}/invite', null);

  Future<ApiResult> acceptInvite({required String inviteCode}) =>
      _request('POST', '/api/invites/accept', {'inviteCode': inviteCode});

  void _rememberToken(ApiResult result) {
    final value = result.body['token'];
    if (result.isSuccess && value is String) {
      token = value;
    }
  }

  Future<ApiResult> _request(String method, String path, Map<String, dynamic>? body) async {
    final testSender = sender;
    if (testSender != null) {
      return testSender(method, path, body, token);
    }

    final target = Uri.tryParse('$baseUrl$path');
    if (target == null || !target.hasScheme) {
      throw ApiException('"$baseUrl" is not a valid server address');
    }

    final client = HttpClient();
    try {
      final request = await client.openUrl(method, target);
      request.headers.set(HttpHeaders.contentTypeHeader, 'application/json; charset=utf-8');
      final sessionToken = token;
      if (sessionToken != null) {
        request.headers.set(HttpHeaders.authorizationHeader, 'Bearer $sessionToken');
      }
      if (body != null) {
        request.write(jsonEncode(body));
      }

      final response = await request.close();
      final responseText = await response.transform(utf8.decoder).join();
      final decoded = responseText.isEmpty ? <String, dynamic>{} : jsonDecode(responseText);

      return ApiResult(
        statusCode: response.statusCode,
        body: decoded is Map<String, dynamic> ? decoded : <String, dynamic>{},
      );
    } on SocketException catch (error) {
      throw ApiException('Could not reach $baseUrl (${error.osError?.message ?? 'no connection'})');
    } on FormatException {
      throw ApiException('The server sent a response the app could not read');
    } finally {
      client.close();
    }
  }
}

/// Accepts either a bare invite code or a full invite URL pasted from a chat.
String readInviteCode(String value) {
  final trimmed = value.trim();
  const marker = 'invite=';
  final index = trimmed.indexOf(marker);
  if (index == -1) {
    return trimmed;
  }
  return Uri.decodeComponent(trimmed.substring(index + marker.length));
}
