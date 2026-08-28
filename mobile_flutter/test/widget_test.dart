import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_flutter/api.dart';
import 'package:mobile_flutter/main.dart';
import 'package:mobile_flutter/screens/group_screen.dart';

ApiResult ok(Map<String, dynamic> body) => ApiResult(statusCode: 200, body: body);

/// A backend stub with just enough routes for the screens under test.
RequestSender backend(Map<String, ApiResult> routes, {List<String>? seen}) {
  return (method, path, body, token) async {
    seen?.add('$method $path');
    return routes['$method $path'] ?? ok(const {});
  };
}

Map<String, dynamic> groupBody({required bool locked, int totalQuotes = 0}) => {
      'group': {
        'id': 'g1',
        'name': 'Sunday football crew',
        'revealYear': 2026,
        'locked': locked,
        'you': {'memberId': 'm1', 'name': 'Alice', 'role': 'owner'},
        'members': [
          {'id': 'm1', 'name': 'Alice', 'role': 'owner', 'isGuest': false, 'isYou': true},
          {'id': 'm2', 'name': 'Cleo', 'role': 'member', 'isGuest': true, 'isYou': false},
        ],
        'progress': {'totalQuotes': totalQuotes, 'recordedByYou': totalQuotes, 'memberCount': 2},
      },
    };

void main() {
  testWidgets('signed-out app shows the sign-in screen', (tester) async {
    final api = QuotesApi(baseUrl: 'https://example.test', sender: backend(const {}));

    await tester.pumpWidget(QuotesJournalApp(api: api));

    expect(find.text('Quotes Journal'), findsOneWidget);
    expect(find.byKey(const Key('email-field')), findsOneWidget);
    expect(find.byKey(const Key('display-name-field')), findsNothing);
  });

  testWidgets('switching to create account reveals the display name field', (tester) async {
    final api = QuotesApi(baseUrl: 'https://example.test', sender: backend(const {}));

    await tester.pumpWidget(QuotesJournalApp(api: api));
    await tester.tap(find.text('Create account'));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('display-name-field')), findsOneWidget);
  });

  testWidgets('signing in moves on to the group list', (tester) async {
    final api = QuotesApi(
      baseUrl: 'https://example.test',
      sender: backend({
        'POST /api/auth/login': ApiResult(statusCode: 200, body: const {
          'token': 'session-token',
          'user': {'id': 'u1', 'displayName': 'Alice'},
        }),
        'GET /api/auth/me': ok(const {
          'user': {'id': 'u1', 'displayName': 'Alice'},
          'groups': [
            {'groupId': 'g1', 'name': 'Sunday football crew', 'revealYear': 2026, 'role': 'owner'}
          ],
        }),
      }),
    );

    await tester.pumpWidget(QuotesJournalApp(api: api));
    await tester.enterText(find.byKey(const Key('email-field')), 'alice@example.com');
    await tester.enterText(find.byKey(const Key('password-field')), 'a long enough password');
    await tester.tap(find.byKey(const Key('submit-button')));
    await tester.pumpAndSettle();

    expect(find.text('Your groups'), findsOneWidget);
    expect(find.text('Sunday football crew'), findsOneWidget);
  });

  testWidgets('a failed sign in stays put and explains why', (tester) async {
    final api = QuotesApi(
      baseUrl: 'https://example.test',
      sender: backend({
        'POST /api/auth/login':
            ApiResult(statusCode: 401, body: const {'error': 'Email or password is incorrect'}),
      }),
    );

    await tester.pumpWidget(QuotesJournalApp(api: api));
    await tester.enterText(find.byKey(const Key('email-field')), 'alice@example.com');
    await tester.enterText(find.byKey(const Key('password-field')), 'wrong password');
    await tester.tap(find.byKey(const Key('submit-button')));
    await tester.pumpAndSettle();

    expect(find.text('Email or password is incorrect'), findsOneWidget);
    expect(find.byKey(const Key('submit-button')), findsOneWidget);
  });

  testWidgets('a locked group hides the reveal tab', (tester) async {
    final api = QuotesApi(
      baseUrl: 'https://example.test',
      sender: backend({'GET /api/groups/g1': ok(groupBody(locked: true, totalQuotes: 3))}),
    );

    await tester.pumpWidget(MaterialApp(home: GroupScreen(api: api, groupId: 'g1')));
    await tester.pumpAndSettle();

    expect(find.text('Add a quote'), findsOneWidget);
    expect(find.text('Members'), findsOneWidget);
    expect(find.text('The reveal'), findsNothing);
    expect(find.text('quotes collected so far · 3 by you'), findsOneWidget);
  });

  testWidgets('an unlocked group shows the reveal with quotes and stats', (tester) async {
    final api = QuotesApi(
      baseUrl: 'https://example.test',
      sender: backend({
        'GET /api/groups/g1': ok(groupBody(locked: false, totalQuotes: 1)),
        'GET /api/groups/g1/quotes': ok(const {
          'quotes': [
            {
              'id': 'q1',
              'text': 'I am not lost, the map is wrong',
              'saidByMemberId': 'm2',
              'recordedByMemberId': 'm1',
              'involvedMemberIds': <String>[],
            }
          ],
        }),
        'GET /api/groups/g1/stats': ok(const {
          'leaderboard': [
            {'memberId': 'm2', 'name': 'Cleo', 'said': 1, 'persisted': 0},
            {'memberId': 'm1', 'name': 'Alice', 'said': 0, 'persisted': 1},
          ],
        }),
      }),
    );

    await tester.pumpWidget(MaterialApp(home: GroupScreen(api: api, groupId: 'g1')));
    await tester.pumpAndSettle();

    await tester.tap(find.text('The reveal'));
    await tester.pumpAndSettle();

    expect(find.text('I am not lost, the map is wrong'), findsOneWidget);
    expect(find.text('— Cleo, recorded by Alice'), findsOneWidget);
    expect(find.text('quoted 1 · collected 0'), findsOneWidget);
  });

  testWidgets('saving a quote posts it and clears the field', (tester) async {
    final seen = <String>[];
    final api = QuotesApi(
      baseUrl: 'https://example.test',
      sender: backend(
        {
          'GET /api/groups/g1': ok(groupBody(locked: true)),
          'POST /api/groups/g1/quotes': ApiResult(statusCode: 201, body: const {'quote': {}}),
        },
        seen: seen,
      ),
    );

    await tester.pumpWidget(MaterialApp(home: GroupScreen(api: api, groupId: 'g1')));
    await tester.pumpAndSettle();

    await tester.enterText(find.byKey(const Key('quote-text-field')), 'The map is wrong');
    await tester.tap(find.byKey(const Key('save-quote-button')));
    await tester.pumpAndSettle();

    expect(seen, contains('POST /api/groups/g1/quotes'));
    expect(find.text('The map is wrong'), findsNothing);
  });
}
