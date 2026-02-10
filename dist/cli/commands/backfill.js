import { BackfillEngine } from '../../analytics/backfill-engine.js';
import { BackfillDedup } from '../../analytics/backfill-dedup.js';
import { colors, formatCostWithColor, formatDuration } from '../utils/formatting.js';
/**
 * Simple ASCII progress bar
 */
function renderProgressBar(current, total, width = 40) {
    const percentage = total > 0 ? current / total : 0;
    const filled = Math.round(width * percentage);
    const empty = width - filled;
    const bar = '█'.repeat(filled) + '░'.repeat(empty);
    const percent = (percentage * 100).toFixed(1);
    return `[${bar}] ${percent}%`;
}
/**
 * Format file size in human-readable format
 */
function formatFileSize(bytes) {
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
/**
 * Clear current line in terminal
 */
function clearLine() {
    process.stdout.write('\r\x1b[K');
}
/**
 * omc backfill command handler
 */
export async function backfillCommand(options) {
    // Handle --reset flag
    if (options.reset) {
        const dedup = new BackfillDedup();
        await dedup.reset();
        if (!options.json) {
            console.log(colors.green('✓ Deduplication index reset successfully'));
            console.log(colors.gray('  All transcripts will be re-processed on next backfill'));
        }
        // Exit if only resetting
        return;
    }
    // Parse date options
    const backfillOptions = {
        projectFilter: options.project,
        dateFrom: options.from ? new Date(options.from) : undefined,
        dateTo: options.to ? new Date(options.to) : undefined,
        dryRun: options.dryRun,
        verbose: options.verbose,
    };
    // Validate dates
    if (backfillOptions.dateFrom && isNaN(backfillOptions.dateFrom.getTime())) {
        console.error(colors.red('Error: Invalid --from date. Use ISO format (YYYY-MM-DD)'));
        process.exit(1);
    }
    if (backfillOptions.dateTo && isNaN(backfillOptions.dateTo.getTime())) {
        console.error(colors.red('Error: Invalid --to date. Use ISO format (YYYY-MM-DD)'));
        process.exit(1);
    }
    // Initialize engine
    const engine = new BackfillEngine();
    // Setup progress handler
    let lastProgress = null;
    engine.on('progress', (progress) => {
        lastProgress = progress;
        if (!options.json && !options.verbose) {
            // Show progress bar
            clearLine();
            const progressBar = renderProgressBar(progress.filesProcessed, progress.totalFiles);
            const currentFile = progress.currentFile.length > 30
                ? '...' + progress.currentFile.slice(-27)
                : progress.currentFile;
            process.stdout.write(`${progressBar} ${colors.cyan(currentFile)} | ` +
                `${colors.green('+' + progress.entriesAdded)} | ` +
                `${colors.yellow('~' + progress.duplicatesSkipped)} | ` +
                formatCostWithColor(progress.currentCost));
        }
        else if (options.verbose && !options.json) {
            console.log(`[${progress.filesProcessed}/${progress.totalFiles}] ${progress.currentFile} ` +
                `(+${progress.entriesAdded}, ~${progress.duplicatesSkipped})`);
        }
    });
    // Show header
    if (!options.json) {
        console.log(colors.bold('\n📊 Backfill Analytics from Transcripts\n'));
        if (options.dryRun) {
            console.log(colors.yellow('⚠️  DRY RUN MODE - No data will be written\n'));
        }
        if (backfillOptions.projectFilter) {
            console.log(colors.gray(`  Project filter: ${backfillOptions.projectFilter}`));
        }
        if (backfillOptions.dateFrom) {
            console.log(colors.gray(`  From: ${backfillOptions.dateFrom.toISOString().split('T')[0]}`));
        }
        if (backfillOptions.dateTo) {
            console.log(colors.gray(`  To: ${backfillOptions.dateTo.toISOString().split('T')[0]}`));
        }
        console.log('');
    }
    // Run backfill
    const startTime = Date.now();
    const result = await engine.run(backfillOptions);
    // Clear progress line
    if (!options.json && !options.verbose) {
        clearLine();
    }
    // Output results
    if (options.json) {
        console.log(JSON.stringify(result, null, 2));
    }
    else {
        console.log(colors.bold('\n✓ Backfill Complete\n'));
        // Summary table
        const summaryTable = [
            ['Files Processed', colors.cyan(result.filesProcessed.toString())],
            ['Entries Added', colors.green(result.entriesAdded.toString())],
            ['Duplicates Skipped', colors.yellow(result.duplicatesSkipped.toString())],
            ['Errors Encountered', result.errorsEncountered > 0
                    ? colors.red(result.errorsEncountered.toString())
                    : colors.gray(result.errorsEncountered.toString())
            ],
            ['Total Cost Discovered', formatCostWithColor(result.totalCostDiscovered)],
            ['Time Elapsed', colors.gray(formatDuration(result.timeElapsed))],
        ];
        // Find max label length for alignment
        const maxLabelLength = Math.max(...summaryTable.map(row => row[0].length));
        for (const [label, value] of summaryTable) {
            const padding = ' '.repeat(maxLabelLength - label.length);
            console.log(`  ${label}${padding}  ${value}`);
        }
        console.log('');
        if (options.dryRun) {
            console.log(colors.yellow('  This was a dry run. Run without --dry-run to write data.'));
            console.log('');
        }
        if (result.errorsEncountered > 0) {
            console.log(colors.yellow(`  ⚠️  ${result.errorsEncountered} errors encountered during processing`));
            console.log(colors.gray('     Run with --verbose to see error details'));
            console.log('');
        }
    }
}
//# sourceMappingURL=backfill.js.map