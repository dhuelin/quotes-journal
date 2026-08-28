import 'dart:convert';
import 'dart:io';

typedef RequestSender = Future<ApiResult> Function(
  String method,
  String path,
  Map<String, dynamic>? body,
);

class ApiResult {
  ApiResult({required this.statusCode, required this.body});

  final int statusCode;
  final Map<String, dynamic> body;
}

class QuotesApi {
  QuotesApi({required this.baseUrl, RequestSender? sender}) : _sender = sender;

  final String baseUrl;
  final RequestSender? _sender;

  Future<ApiResult> createGroup({required String name, required int revealYear}) {
    return _request('POST', '/api/groups', {
      'name': name,
      'revealYear': revealYear,
    });
  }

  Future<ApiResult> addMember({required String groupId, required String name}) {
    return _request('POST', '/api/groups/$groupId/members', {'name': name});
  }

  Future<ApiResult> addQuote({
    required String groupId,
    required String text,
    required String saidByMemberId,
    required String recordedByMemberId,
    required List<String> involvedMemberIds,
  }) {
    return _request('POST', '/api/groups/$groupId/quotes', {
      'text': text,
      'saidByMemberId': saidByMemberId,
      'recordedByMemberId': recordedByMemberId,
      'involvedMemberIds': involvedMemberIds,
    });
  }

  Future<ApiResult> getQuotes({required String groupId}) {
    return _request('GET', '/api/groups/$groupId/quotes', null);
  }

  Future<ApiResult> getQuiz({required String groupId}) {
    return _request('GET', '/api/groups/$groupId/quiz', null);
  }

  Future<ApiResult> getStats({required String groupId}) {
    return _request('GET', '/api/groups/$groupId/stats', null);
  }

  Future<ApiResult> _request(String method, String path, Map<String, dynamic>? body) async {
    if (_sender != null) {
      return _sender(method, path, body);
    }

    final client = HttpClient();
    try {
      final request = await client.openUrl(method, Uri.parse('$baseUrl$path'));
      request.headers.set(HttpHeaders.contentTypeHeader, 'application/json; charset=utf-8');
      if (body != null) {
        request.write(jsonEncode(body));
      }

      final response = await request.close();
      final responseText = await response.transform(utf8.decoder).join();
      final decoded = responseText.isEmpty
          ? <String, dynamic>{}
          : (jsonDecode(responseText) as Map<String, dynamic>);
      return ApiResult(statusCode: response.statusCode, body: decoded);
    } finally {
      client.close();
    }
  }
}
