import 'package:flutter/material.dart';

import 'api.dart';
import 'screens/group_screen.dart';
import 'screens/groups_screen.dart';
import 'screens/sign_in_screen.dart';

/// Where the app talks to. Production by default; override at build time to
/// point a build at a local Worker:
/// `flutter run --dart-define=QUOTES_JOURNAL_URL=http://10.0.2.2:8787`
///
/// Compile-time on purpose: a release build cannot be repointed at another host
/// after the fact, by anyone.
const String defaultBaseUrl = String.fromEnvironment(
  'QUOTES_JOURNAL_URL',
  defaultValue: 'https://quotes.huelin.dev',
);

void main() {
  runApp(const QuotesJournalApp());
}

class QuotesJournalApp extends StatefulWidget {
  const QuotesJournalApp({super.key, this.api});

  /// Injected by tests so the widget tree can run without a network.
  final QuotesApi? api;

  @override
  State<QuotesJournalApp> createState() => _QuotesJournalAppState();
}

class _QuotesJournalAppState extends State<QuotesJournalApp> {
  late final QuotesApi _api = widget.api ?? QuotesApi(baseUrl: defaultBaseUrl);

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Quotes Journal',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        useMaterial3: true,
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFFF8C630),
          brightness: Brightness.dark,
        ),
      ),
      home: _api.isSignedIn
          ? GroupsScreen(api: _api)
          : SignInScreen(
              api: _api,
              onSignedIn: () => setState(() {}),
            ),
    );
  }
}

/// Shared helper: runs an API call, shows a snack bar on failure and returns
/// the result only when it succeeded.
/// [ignoreFailure] suppresses the snack bar for a failure the caller intends to
/// handle itself — a name collision on join, say, where the right answer is to
/// ask for another name rather than to show an error and stop.
Future<ApiResult?> runCall(
  BuildContext context,
  Future<ApiResult> Function() call, {
  String? successMessage,
  bool Function(ApiResult failure)? ignoreFailure,
}) async {
  final messenger = ScaffoldMessenger.of(context);
  try {
    final result = await call();
    if (!result.isSuccess) {
      if (ignoreFailure == null || !ignoreFailure(result)) {
        messenger.showSnackBar(SnackBar(content: Text(result.errorMessage)));
      }
      return null;
    }
    if (successMessage != null) {
      messenger.showSnackBar(SnackBar(content: Text(successMessage)));
    }
    return result;
  } on ApiException catch (error) {
    messenger.showSnackBar(SnackBar(content: Text(error.message)));
    return null;
  }
}

/// Routes used by the screens; kept here so tests can push them directly.
Route<void> groupRoute(QuotesApi api, String groupId) =>
    MaterialPageRoute<void>(builder: (_) => GroupScreen(api: api, groupId: groupId));
