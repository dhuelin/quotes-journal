import 'package:flutter/material.dart';

import '../api.dart';
import '../main.dart';
import 'groups_screen.dart';

class SignInScreen extends StatefulWidget {
  const SignInScreen({super.key, required this.api, required this.onSignedIn});

  final QuotesApi api;
  final VoidCallback onSignedIn;

  @override
  State<SignInScreen> createState() => _SignInScreenState();
}

class _SignInScreenState extends State<SignInScreen> {
  final _displayName = TextEditingController();
  final _email = TextEditingController();
  final _password = TextEditingController();

  bool _registering = false;
  bool _busy = false;

  @override
  void dispose() {
    _displayName.dispose();
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    setState(() => _busy = true);

    final result = await runCall(context, () {
      if (_registering) {
        return widget.api.register(
          displayName: _displayName.text.trim(),
          email: _email.text.trim(),
          password: _password.text,
        );
      }
      return widget.api.login(email: _email.text.trim(), password: _password.text);
    });

    if (!mounted) {
      return;
    }
    setState(() => _busy = false);

    if (result != null) {
      widget.onSignedIn();
      await Navigator.of(context).pushReplacement(
        MaterialPageRoute<void>(builder: (_) => GroupsScreen(api: widget.api)),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const SizedBox(height: 24),
              Text('Quotes Journal', style: Theme.of(context).textTheme.headlineMedium),
              const SizedBox(height: 8),
              const Text(
                'Collect the year’s best quotes with your friends. '
                'Everything stays sealed until 1 January.',
              ),
              const SizedBox(height: 24),
              SegmentedButton<bool>(
                segments: const [
                  ButtonSegment(value: false, label: Text('Sign in')),
                  ButtonSegment(value: true, label: Text('Create account')),
                ],
                selected: {_registering},
                onSelectionChanged: (selection) => setState(() => _registering = selection.first),
              ),
              const SizedBox(height: 16),
              if (_registering) ...[
                TextField(
                  key: const Key('display-name-field'),
                  controller: _displayName,
                  decoration: const InputDecoration(
                    labelText: 'Display name',
                    helperText: 'The name your friends see next to quotes',
                  ),
                ),
                const SizedBox(height: 12),
              ],
              TextField(
                key: const Key('email-field'),
                controller: _email,
                keyboardType: TextInputType.emailAddress,
                autocorrect: false,
                decoration: const InputDecoration(labelText: 'Email'),
              ),
              const SizedBox(height: 12),
              TextField(
                key: const Key('password-field'),
                controller: _password,
                obscureText: true,
                decoration: const InputDecoration(
                  labelText: 'Password',
                  helperText: 'At least 10 characters',
                ),
              ),
              const SizedBox(height: 24),
              FilledButton(
                key: const Key('submit-button'),
                onPressed: _busy ? null : _submit,
                child: Text(_registering ? 'Create account' : 'Sign in'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
