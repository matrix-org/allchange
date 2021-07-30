/*
Copyright 2021 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { changeFromPrInfo, PrInfo, ChangeType } from './changes';

const FIX_MAGIC_WORDS = [
    'close',
    'closes',
    'closed',
    'fix',
    'fixes',
    'fixed',
    'resolve',
    'resolves',
    'resolved',
];

const FIX_MAGIC_WORDS_ALLVARIANTS = FIX_MAGIC_WORDS.concat(FIX_MAGIC_WORDS.map(w => w[0].toUpperCase() + w.slice(1)));

function mockPr(): PrInfo {
    return {
        title: '',
        body: '',
        labels: [],
        base: {
            repo: {
                name: 'bert',
                owner: {
                    name: 'thingtransformer',
                },
            },
        },
    } as PrInfo;
}

test('Notes defaults to PR title', () => {
    const pr = mockPr();
    pr.title = 'fixes all problems';

    expect(changeFromPrInfo(pr).notes).toEqual('fixes all problems');
});

test('Notes picked up from PR body (lowercase)', () => {
    const pr = mockPr();
    pr.body = [
        "Does a thing",
        "notes: this does a thing",
    ].join("\n");

    expect(changeFromPrInfo(pr).notes).toEqual('this does a thing');
});

test('Notes picked up from PR body (capitalised)', () => {
    const pr = mockPr();
    pr.body = [
        "Does a thing",
        "Notes: this does a thing",
    ].join("\n");

    expect(changeFromPrInfo(pr).notes).toEqual('this does a thing');
});

test('Headline picked up from PR body (lowercase)', () => {
    const pr = mockPr();
    pr.body = [
        "Does a thing",
        "headlines: this does a thing",
    ].join("\n");

    expect(changeFromPrInfo(pr).headline).toEqual('this does a thing');
});

test('Headline picked up from PR body (capitalised)', () => {
    const pr = mockPr();
    pr.body = [
        "Does a thing",
        "Headlines: this does a thing",
    ].join("\n");

    expect(changeFromPrInfo(pr).headline).toEqual('this does a thing');
});

test('Type picked up from labels', () => {
    const pr = mockPr();

    pr.labels = [
        { name: 'T-Enhancement' },
    ];
    expect(changeFromPrInfo(pr).changeType).toEqual(ChangeType.FEATURE);

    pr.labels = [
        { name: 'T-Defect' },
    ];
    expect(changeFromPrInfo(pr).changeType).toEqual(ChangeType.BUGFIX);

    pr.labels = [
        { name: 'T-Task' },
    ];
    expect(changeFromPrInfo(pr).changeType).toEqual(ChangeType.TASK);
});

test('Breaking change label marks as breaking', () => {
    const pr = mockPr();
    pr.labels = [
        { name: 'X-Breaking-Change' },
    ];

    expect(changeFromPrInfo(pr).breaking).toEqual(true);
});

test('Breaking defaults to false', () => {
    const pr = mockPr();

    expect(changeFromPrInfo(pr).breaking).toEqual(false);
});

test('Project notes picked up from PR body', () => {
    const pr = mockPr();
    pr.body = [
        "Does a thing",
        "boopity-boo notes: this does a thing",
    ].join("\n");

    expect(changeFromPrInfo(pr).notesByProject['boopity-boo']).toEqual('this does a thing');
});

test('Fixes parsed from #123', () => {
    for (const magicWord of FIX_MAGIC_WORDS_ALLVARIANTS) {
        const pr = mockPr();
        // with colon
        pr.body = [
            "Does a thing",
            `this ${magicWord}: #123`,
        ].join("\n");

        expect(changeFromPrInfo(pr).fixes[0]).toEqual({
            owner: pr.base.repo.owner.name,
            repo: pr.base.repo.name,
            number: 123,
        });

        // without
        pr.body = [
            "Does a thing",
            `${magicWord} #123`,
        ].join("\n");

        expect(changeFromPrInfo(pr).fixes[0]).toEqual({
            owner: pr.base.repo.owner.name,
            repo: pr.base.repo.name,
            number: 123,
        });
    }
});

test('Fixes parsed from owner/repo#123', () => {
    for (const magicWord of FIX_MAGIC_WORDS_ALLVARIANTS) {
        const pr = mockPr();
        // with colon
        pr.body = [
            "Does a thing",
            `this ${magicWord}: bert/llamalist#123`,
        ].join("\n");

        expect(changeFromPrInfo(pr).fixes[0]).toEqual({
            owner: 'bert',
            repo: 'llamalist',
            number: 123,
        });

        // without
        pr.body = [
            "Does a thing",
            `${magicWord} bert/llamalist#123#123`,
        ].join("\n");

        expect(changeFromPrInfo(pr).fixes[0]).toEqual({
            owner: 'bert',
            repo: 'llamalist',
            number: 123,
        });
    }
});

test('Fixes parsed from issue URL', () => {
    for (const magicWord of FIX_MAGIC_WORDS_ALLVARIANTS) {
        const pr = mockPr();
        // with colon
        pr.body = [
            "Does a thing",
            `this ${magicWord}: https://github.com/bert/llamalist/issues/123`,
        ].join("\n");

        expect(changeFromPrInfo(pr).fixes[0]).toEqual({
            owner: 'bert',
            repo: 'llamalist',
            number: 123,
        });

        // without
        pr.body = [
            "Does a thing",
            `${magicWord} https://github.com/bert/llamalist/issues/123`,
        ].join("\n");

        expect(changeFromPrInfo(pr).fixes[0]).toEqual({
            owner: 'bert',
            repo: 'llamalist',
            number: 123,
        });

        // http
        pr.body = [
            "Does a thing",
            `${magicWord} http://github.com/bert/llamalist/issues/123`,
        ].join("\n");

        expect(changeFromPrInfo(pr).fixes[0]).toEqual({
            owner: 'bert',
            repo: 'llamalist',
            number: 123,
        });
    }
});

