import 'dart:convert';

import 'package:flutter/material.dart';

import 'api.dart';

void main() {
  runApp(const QuotesJournalApp());
}

class QuotesJournalApp extends StatelessWidget {
  const QuotesJournalApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Quotes Journal',
      theme: ThemeData(colorScheme: ColorScheme.fromSeed(seedColor: Colors.indigo)),
      home: const HomeScreen(),
    );
  }
}

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  final _baseUrlController = TextEditingController(text: 'https://quotes-journal.example.workers.dev');
  final _groupIdController = TextEditingController();
  final _groupNameController = TextEditingController();
  final _revealYearController = TextEditingController(text: DateTime.now().year.toString());
  final _memberNameController = TextEditingController();
  final _quoteController = TextEditingController();
  final _saidByController = TextEditingController();
  final _recordedByController = TextEditingController();
  final _involvedController = TextEditingController();

  String _output = 'Ready';

  QuotesApi get _api => QuotesApi(baseUrl: _baseUrlController.text.trim());

  @override
  void dispose() {
    _baseUrlController.dispose();
    _groupIdController.dispose();
    _groupNameController.dispose();
    _revealYearController.dispose();
    _memberNameController.dispose();
    _quoteController.dispose();
    _saidByController.dispose();
    _recordedByController.dispose();
    _involvedController.dispose();
    super.dispose();
  }

  Future<void> _runAction(Future<ApiResult> Function() action) async {
    setState(() => _output = 'Loading...');
    try {
      final result = await action();
      setState(() {
        _output = const JsonEncoder.withIndent('  ').convert({
          'status': result.statusCode,
          'body': result.body,
        });
      });
    } catch (error) {
      setState(() => _output = 'Error: $error');
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Quotes Journal (Native Flutter)')),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            TextField(
              key: const Key('base-url-field'),
              controller: _baseUrlController,
              decoration: const InputDecoration(labelText: 'Backend URL'),
            ),
            const SizedBox(height: 12),
            TextField(
              key: const Key('group-id-field'),
              controller: _groupIdController,
              decoration: const InputDecoration(labelText: 'Group ID'),
            ),
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                FilledButton(
                  onPressed: () => _runAction(() {
                    final revealYear = int.tryParse(_revealYearController.text.trim()) ?? DateTime.now().year;
                    return _api.createGroup(name: _groupNameController.text.trim(), revealYear: revealYear);
                  }),
                  child: const Text('Create group'),
                ),
                FilledButton(
                  onPressed: () => _runAction(() => _api.addMember(
                        groupId: _groupIdController.text.trim(),
                        name: _memberNameController.text.trim(),
                      )),
                  child: const Text('Add member'),
                ),
                FilledButton(
                  onPressed: () => _runAction(() => _api.addQuote(
                        groupId: _groupIdController.text.trim(),
                        text: _quoteController.text.trim(),
                        saidByMemberId: _saidByController.text.trim(),
                        recordedByMemberId: _recordedByController.text.trim(),
                        involvedMemberIds: _involvedController.text
                            .split(',')
                            .map((value) => value.trim())
                            .where((value) => value.isNotEmpty)
                            .toList(),
                      )),
                  child: const Text('Add quote'),
                ),
                FilledButton(
                  onPressed: () => _runAction(() => _api.getQuotes(groupId: _groupIdController.text.trim())),
                  child: const Text('Get quotes'),
                ),
                FilledButton(
                  onPressed: () => _runAction(() => _api.getQuiz(groupId: _groupIdController.text.trim())),
                  child: const Text('Get quiz'),
                ),
                FilledButton(
                  onPressed: () => _runAction(() => _api.getStats(groupId: _groupIdController.text.trim())),
                  child: const Text('Get stats'),
                ),
              ],
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _groupNameController,
              decoration: const InputDecoration(labelText: 'Group name'),
            ),
            TextField(
              controller: _revealYearController,
              decoration: const InputDecoration(labelText: 'Reveal year'),
            ),
            TextField(
              controller: _memberNameController,
              decoration: const InputDecoration(labelText: 'Member name'),
            ),
            TextField(
              controller: _quoteController,
              decoration: const InputDecoration(labelText: 'Quote text'),
            ),
            TextField(
              controller: _saidByController,
              decoration: const InputDecoration(labelText: 'Said by member ID'),
            ),
            TextField(
              controller: _recordedByController,
              decoration: const InputDecoration(labelText: 'Recorded by member ID'),
            ),
            TextField(
              controller: _involvedController,
              decoration: const InputDecoration(labelText: 'Involved member IDs (comma separated)'),
            ),
            const SizedBox(height: 16),
            const Text('Output'),
            const SizedBox(height: 8),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: Colors.black,
                borderRadius: BorderRadius.circular(8),
              ),
              child: SelectableText(
                _output,
                key: const Key('output-view'),
                style: const TextStyle(color: Colors.white, fontFamily: 'monospace'),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
