import 'package:flutter/material.dart';

import 'api.dart';
import 'screens/group_screen.dart';
import 'screens/groups_screen.dart';
import 'screens/sign_in_screen.dart';

/// Where the app talks to. Override at build time:
/// `flutter build apk --dart-define=QUOTES_JOURNAL_URL=https://…workers.dev`
const String defaultBaseUrl = String.fromEnvironment(
  'QUOTES_JOURNAL_URL',
  defaultValue: 'https://quotes-journal.example.workers.dev',
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
Future<ApiResult?> runCall(
  BuildContext context,
  Future<ApiResult> Function() call, {
  String? successMessage,
}) async {
  final messenger = ScaffoldMessenger.of(context);
  try {
    final result = await call();
    if (!result.isSuccess) {
      messenger.showSnackBar(SnackBar(content: Text(result.errorMessage)));
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
